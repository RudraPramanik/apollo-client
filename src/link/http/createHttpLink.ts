import '../../utilities/globals';

import { visit, DefinitionNode, VariableDefinitionNode } from 'graphql';

import { ApolloLink } from '../core';
import { Observable } from '../../utilities';
import { serializeFetchParameter } from './serializeFetchParameter';
import { selectURI } from './selectURI';
import { parseAndCheckHttpResponse } from './parseAndCheckHttpResponse';
import { checkFetcher } from './checkFetcher';
import {
  selectHttpOptionsAndBody,
  defaultPrinter,
  fallbackHttpConfig,
  HttpOptions
} from './selectHttpOptionsAndBody';
import { createSignalIfSupported } from './createSignalIfSupported';
import { rewriteURIForGET } from './rewriteURIForGET';
import { fromError } from '../utils';
import { maybe } from '../../utilities';

const backupFetch = maybe(() => fetch);

export const createHttpLink = (linkOptions: HttpOptions = {}) => {
  let {
    uri = '/graphql',
    // use default global fetch if nothing passed in
    fetch: preferredFetch,
    print = defaultPrinter,
    includeExtensions,
    useGETForQueries,
    includeUnusedVariables = false,
    ...requestOptions
  } = linkOptions;

  if (__DEV__) {
    // Make sure at least one of preferredFetch, window.fetch, or backupFetch is
    // defined, so requests won't fail at runtime.
    checkFetcher(preferredFetch || backupFetch);
  }

  const linkConfig = {
    http: { includeExtensions },
    options: requestOptions.fetchOptions,
    credentials: requestOptions.credentials,
    headers: requestOptions.headers,
  };

  return new ApolloLink(operation => {
    let chosenURI = selectURI(operation, uri);

    const context = operation.getContext();

    // `apollographql-client-*` headers are automatically set if a
    // `clientAwareness` object is found in the context. These headers are
    // set first, followed by the rest of the headers pulled from
    // `context.headers`. If desired, `apollographql-client-*` headers set by
    // the `clientAwareness` object can be overridden by
    // `apollographql-client-*` headers set in `context.headers`.
    const clientAwarenessHeaders: {
      'apollographql-client-name'?: string;
      'apollographql-client-version'?: string;
    } = {};

    if (context.clientAwareness) {
      const { name, version } = context.clientAwareness;
      if (name) {
        clientAwarenessHeaders['apollographql-client-name'] = name;
      }
      if (version) {
        clientAwarenessHeaders['apollographql-client-version'] = version;
      }
    }

    const contextHeaders = { ...clientAwarenessHeaders, ...context.headers };

    const contextConfig = {
      http: context.http,
      options: context.fetchOptions,
      credentials: context.credentials,
      headers: contextHeaders,
    };

    //uses fallback, link, and then context to build options
    const { options, body } = selectHttpOptionsAndBody(
      operation,
      print,
      fallbackHttpConfig,
      linkConfig,
      contextConfig,
    );

    if (body.variables && !includeUnusedVariables) {
      const unusedNames = new Set(Object.keys(body.variables));
      visit(operation.query, {
        Variable(node, _key, parent) {
          // A variable type definition at the top level of a query is not
          // enough to silence server-side errors about the variable being
          // unused, so variable definitions do not count as usage.
          // https://spec.graphql.org/draft/#sec-All-Variables-Used
          if (parent && (parent as VariableDefinitionNode).kind !== 'VariableDefinition') {
            unusedNames.delete(node.name.value);
          }
        },
      });
      if (unusedNames.size) {
        // Make a shallow copy of body.variables (with keys in the same
        // order) and then delete unused variables from the copy.
        body.variables = { ...body.variables };
        unusedNames.forEach(name => {
          delete body.variables![name];
        });
      }
    }

    let controller: any;
    if (!(options as any).signal) {
      const { controller: _controller, signal } = createSignalIfSupported();
      controller = _controller;
      if (controller) (options as any).signal = signal;
    }

    // If requested, set method to GET if there are no mutations.
    const definitionIsMutation = (d: DefinitionNode) => {
      return d.kind === 'OperationDefinition' && d.operation === 'mutation';
    };
    if (
      useGETForQueries &&
      !operation.query.definitions.some(definitionIsMutation)
    ) {
      options.method = 'GET';
    }

    if (options.method === 'GET') {
      const { newURI, parseError } = rewriteURIForGET(chosenURI, body);
      if (parseError) {
        return fromError(parseError);
      }
      chosenURI = newURI;
    } else {
      try {
        (options as any).body = serializeFetchParameter(body, 'Payload');
      } catch (parseError) {
        return fromError(parseError);
      }
    }

    return new Observable(observer => {
      // Prefer linkOptions.fetch (preferredFetch) if provided, and otherwise
      // fall back to the *current* global window.fetch function (see issue
      // #7832), or (if all else fails) the backupFetch function we saved when
      // this module was first evaluated. This last option protects against the
      // removal of window.fetch, which is unlikely but not impossible.
      const currentFetch = preferredFetch || maybe(() => fetch) || backupFetch;

      currentFetch!(chosenURI, options)
        .then(response => {
          operation.setContext({ response });
          return response;
        })
        .then(parseAndCheckHttpResponse(operation))
        .then(result => {
          // we have data and can send it to back up the link chain
          observer.next(result);
          observer.complete();
          return result;
        })
        .catch(err => {
          // fetch was cancelled so it's already been cleaned up in the unsubscribe
          if (err.name === 'AbortError') return;
          // if it is a network error, BUT there is graphql result info
          // fire the next observer before calling error
          // this gives apollo-client (and react-apollo) the `graphqlErrors` and `networErrors`
          // to pass to UI
          // this should only happen if we *also* have data as part of the response key per
          // the spec
          if (err.result && err.result.errors && err.result.data) {
            // if we don't call next, the UI can only show networkError because AC didn't
            // get any graphqlErrors
            // this is graphql execution result info (i.e errors and possibly data)
            // this is because there is no formal spec how errors should translate to
            // http status codes. So an auth error (401) could have both data
            // from a public field, errors from a private field, and a status of 401
            // {
            //  user { // this will have errors
            //    firstName
            //  }
            //  products { // this is public so will have data
            //    cost
            //  }
            // }
            //
            // the result of above *could* look like this:
            // {
            //   data: { products: [{ cost: "$10" }] },
            //   errors: [{
            //      message: 'your session has timed out',
            //      path: []
            //   }]
            // }
            // status code of above would be a 401
            // in the UI you want to show data where you can, errors as data where you can
            // and use correct http status codes
            observer.next(err.result);
          }
          observer.error(err);
        });

      return () => {
        // XXX support canceling this request
        // https://developers.google.com/web/updates/2017/09/abortable-fetch
        if (controller) controller.abort();
      };
    });
  });
};

import { createRoot } from 'react-dom/client';
import {
  Action,
  ActionsRegistry,
  getExtendedActionState,
  getExtendedInterstitialState,
  getExtendedWebsiteState,
  type ActionAdapter,
  type ActionCallbacksConfig,
} from '../api';
import { checkSecurity, type SecurityLevel } from '../shared';
import { ActionContainer } from '../ui';
import { noop } from '../utils/constants';
import { isInterstitial } from '../utils/interstitial-url.ts';
import { proxify } from '../utils/proxify.ts';
import { ActionsURLMapper, type ActionsJsonConfig } from '../utils/url-mapper';

type ObserverSecurityLevel = SecurityLevel;

export interface ObserverOptions {
  // trusted > unknown > malicious
  securityLevel:
    | ObserverSecurityLevel
    | Record<'websites' | 'interstitials' | 'actions', ObserverSecurityLevel>;
}

interface NormalizedObserverOptions {
  securityLevel: Record<
    'websites' | 'interstitials' | 'actions',
    ObserverSecurityLevel
  >;
}

const DEFAULT_OPTIONS: ObserverOptions = {
  securityLevel: 'only-trusted',
};

const normalizeOptions = (
  options: Partial<ObserverOptions>,
): NormalizedObserverOptions => {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    securityLevel: (() => {
      if (!options.securityLevel) {
        return {
          websites: DEFAULT_OPTIONS.securityLevel as ObserverSecurityLevel,
          interstitials: DEFAULT_OPTIONS.securityLevel as ObserverSecurityLevel,
          actions: DEFAULT_OPTIONS.securityLevel as ObserverSecurityLevel,
        };
      }

      if (typeof options.securityLevel === 'string') {
        return {
          websites: options.securityLevel,
          interstitials: options.securityLevel,
          actions: options.securityLevel,
        };
      }

      return options.securityLevel;
    })(),
  };
};

export function setupTwitterObserver(
  config: ActionAdapter,
  callbacks: Partial<ActionCallbacksConfig> = {},
  options: Partial<ObserverOptions> = DEFAULT_OPTIONS,
) {
  const mergedOptions = normalizeOptions(options);
  const twitterReactRoot = document.getElementById('react-root')!;

  const refreshRegistry = async () => {
    await ActionsRegistry.getInstance().init();

    setTimeout(refreshRegistry, 1000 * 60 * 10); // every 10 minutes
  };

  // if we don't have the registry, then we don't show anything
  refreshRegistry().then(() => {
    // entrypoint
    const observer = new MutationObserver((mutations) => {
      // it's fast to iterate like this
      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];
        for (let j = 0; j < mutation.addedNodes.length; j++) {
          const node = mutation.addedNodes[j];
          if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
          }
          handleNewNode(
            node as Element,
            config,
            callbacks,
            mergedOptions,
          ).catch(noop);
        }
      }
    });

    observer.observe(twitterReactRoot, { childList: true, subtree: true });
  });
}

async function handleNewNode(
  node: Element,
  config: ActionAdapter,
  callbacks: Partial<ActionCallbacksConfig>,
  options: NormalizedObserverOptions,
) {
  const element = node as Element;
  // first quick filtration
  if (!element || element.localName !== 'div') {
    return;
  }
  const rootElement = findElementByTestId(element, 'card.wrapper');
  if (!rootElement) {
    return;
  }
  // handle link preview only, assuming that link preview is a must for actions
  const linkPreview = rootElement.children[0] as HTMLDivElement;
  if (!linkPreview) {
    return;
  }
  const anchor = linkPreview.children[0] as HTMLAnchorElement;
  const shortenedUrl = anchor.href;
  const actionUrl = await resolveTwitterShortenedUrl(shortenedUrl);
  const interstitialData = isInterstitial(actionUrl);

  let actionApiUrl: string | null;
  if (interstitialData.isInterstitial) {
    const interstitialState = getExtendedInterstitialState(
      actionUrl.toString(),
    );

    if (
      !checkSecurity(interstitialState, options.securityLevel.interstitials)
    ) {
      return;
    }

    actionApiUrl = interstitialData.decodedActionUrl;
  } else {
    const websiteState = getExtendedWebsiteState(actionUrl.toString());

    if (!checkSecurity(websiteState, options.securityLevel.websites)) {
      return;
    }

    const actionsJsonUrl = actionUrl.origin + '/actions.json';
    const actionsJson = await fetch(proxify(actionsJsonUrl)).then(
      (res) => res.json() as Promise<ActionsJsonConfig>,
    );

    const actionsUrlMapper = new ActionsURLMapper(actionsJson);

    actionApiUrl = actionsUrlMapper.mapUrl(actionUrl);
  }

  const state = actionApiUrl ? getExtendedActionState(actionApiUrl) : null;
  if (
    !actionApiUrl ||
    !state ||
    !checkSecurity(state, options.securityLevel.actions)
  ) {
    return;
  }

  const action = await Action.fetch(actionApiUrl, config).catch(() => null);

  if (!action) {
    return;
  }

  rootElement.parentElement?.replaceChildren(
    createAction({
      originalUrl: actionUrl,
      action,
      callbacks,
      options,
      isInterstitial: interstitialData.isInterstitial,
    }),
  );
}

function createAction({
  originalUrl,
  action,
  callbacks,
  options,
}: {
  originalUrl: URL;
  action: Action;
  callbacks: Partial<ActionCallbacksConfig>;
  options: NormalizedObserverOptions;
  isInterstitial: boolean;
}) {
  const container = document.createElement('div');
  container.className = 'dialect-action-root-container';

  const actionRoot = createRoot(container);

  actionRoot.render(
    <ActionContainer
      action={action}
      websiteUrl={originalUrl.toString()}
      websiteText={originalUrl.hostname}
      callbacks={callbacks}
      securityLevel={options.securityLevel}
    />,
  );

  return container;
}

async function resolveTwitterShortenedUrl(shortenedUrl: string): Promise<URL> {
  const res = await fetch(shortenedUrl);
  const html = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const actionUrl = doc.querySelector('title')?.textContent;
  return new URL(actionUrl!);
}

function findElementByTestId(element: Element, testId: string) {
  if (element.attributes.getNamedItem('data-testid')?.value === testId) {
    return element;
  }
  return element.querySelector(`[data-testid="${testId}"]`);
}

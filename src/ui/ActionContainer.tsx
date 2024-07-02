import { useEffect, useMemo, useReducer, useState } from 'react';
import {
  Action,
  ActionComponent,
  getExtendedActionState,
  getExtendedInterstitialState,
  getExtendedWebsiteState,
  mergeActionStates,
  type ActionCallbacksConfig,
  type ActionContext,
  type ExtendedActionState,
} from '../api';
import { checkSecurity, type SecurityLevel } from '../shared';
import { isInterstitial } from '../utils/interstitial-url.ts';
import { isSignTransactionError } from '../utils/type-guards.ts';
import type { ButtonProps } from './ActionLayout';
import { ActionLayout } from './ActionLayout';
import { Snackbar } from './Snackbar.tsx';

type ExecutionStatus = 'blocked' | 'idle' | 'executing' | 'success' | 'error';

interface ExecutionState {
  status: ExecutionStatus;
  executingAction?: ActionComponent | null;
  errorMessage?: string | null;
  successMessage?: string | null;
}

enum ExecutionType {
  INITIATE = 'INITIATE',
  FINISH = 'FINISH',
  FAIL = 'FAIL',
  RESET = 'RESET',
  UNBLOCK = 'UNBLOCK',
  BLOCK = 'BLOCK',
}

type ActionValue =
  | {
      type: ExecutionType.INITIATE;
      executingAction: ActionComponent;
      errorMessage?: string;
    }
  | {
      type: ExecutionType.FINISH;
      successMessage?: string | null;
    }
  | {
      type: ExecutionType.FAIL;
      errorMessage: string;
    }
  | {
      type: ExecutionType.RESET;
    }
  | {
      type: ExecutionType.UNBLOCK;
    }
  | {
      type: ExecutionType.BLOCK;
    };

const executionReducer = (
  state: ExecutionState,
  action: ActionValue,
): ExecutionState => {
  switch (action.type) {
    case ExecutionType.INITIATE:
      return { status: 'executing', executingAction: action.executingAction };
    case ExecutionType.FINISH:
      return {
        ...state,
        status: 'success',
        successMessage: action.successMessage,
        errorMessage: null,
      };
    case ExecutionType.FAIL:
      return {
        ...state,
        status: 'error',
        errorMessage: action.errorMessage,
        successMessage: null,
      };
    case ExecutionType.RESET:
      return {
        status: 'idle',
      };
    case ExecutionType.BLOCK:
      return {
        status: 'blocked',
      };
    case ExecutionType.UNBLOCK:
      return {
        status: 'idle',
      };
  }
};

const buttonVariantMap: Record<
  ExecutionStatus,
  'default' | 'error' | 'success'
> = {
  blocked: 'default',
  idle: 'default',
  executing: 'default',
  success: 'success',
  error: 'error',
};

const buttonLabelMap: Record<ExecutionStatus, string | null> = {
  blocked: null,
  idle: null,
  executing: 'Executing',
  success: 'Completed',
  error: 'Failed',
};

type ActionStateWithOrigin =
  | {
      action: ExtendedActionState;
      origin?: never;
    }
  | {
      action: ExtendedActionState;
      origin: ExtendedActionState;
      originType: Source;
    };

const getOverallActionState = (
  action: Action,
  websiteUrl?: string | null,
): ActionStateWithOrigin => {
  const actionState = getExtendedActionState(action);
  const originalUrlData = websiteUrl ? isInterstitial(websiteUrl) : null;

  if (!originalUrlData) {
    return {
      action: actionState,
    };
  }

  if (originalUrlData.isInterstitial) {
    return {
      action: actionState,
      origin: getExtendedInterstitialState(websiteUrl!),
      originType: 'interstitials' as Source,
    };
  }

  return {
    action: actionState,
    origin: getExtendedWebsiteState(websiteUrl!),
    originType: 'websites' as Source,
  };
};

const checkSecurityFromActionState = (
  state: ActionStateWithOrigin,
  normalizedSecurityLevel: NormalizedSecurityLevel,
): boolean => {
  return checkSecurity(state.action, normalizedSecurityLevel.actions) &&
    state.origin
    ? checkSecurity(state.origin, normalizedSecurityLevel[state.originType])
    : true;
};

const SOFT_LIMIT_BUTTONS = 10;
const SOFT_LIMIT_INPUTS = 3;
const DEFAULT_SECURITY_LEVEL: SecurityLevel = 'only-trusted';

type Source = 'websites' | 'interstitials' | 'actions';
type NormalizedSecurityLevel = Record<Source, SecurityLevel>;

// solana-action://action?http://...json

// solana-action://portfolio/:useraddress

export const ActionContainer = ({
  action,
  websiteUrl,
  websiteText,
  callbacks,
  securityLevel = DEFAULT_SECURITY_LEVEL,
}: {
  action: Action;
  websiteUrl?: string | null;
  websiteText?: string | null;
  callbacks?: Partial<ActionCallbacksConfig>;
  securityLevel?: SecurityLevel | NormalizedSecurityLevel;
}) => {
  const normalizedSecurityLevel: NormalizedSecurityLevel = useMemo(() => {
    if (typeof securityLevel === 'string') {
      return {
        websites: securityLevel,
        interstitials: securityLevel,
        actions: securityLevel,
      };
    }

    return securityLevel;
  }, [securityLevel]);

  const [actionState, setActionState] = useState(
    getOverallActionState(action, websiteUrl),
  );
  const overallState = useMemo(
    () =>
      mergeActionStates(
        ...([actionState.action, actionState.origin].filter(
          Boolean,
        ) as ExtendedActionState[]),
      ),
    [actionState],
  );

  // adding ui check as well, to make sure, that on runtime registry lookups, we are not allowing the action to be executed
  const isPassingSecurityCheck = checkSecurityFromActionState(
    actionState,
    normalizedSecurityLevel,
  );

  const [executionState, dispatch] = useReducer(executionReducer, {
    status:
      overallState !== 'malicious' && isPassingSecurityCheck
        ? 'idle'
        : 'blocked',
  });

  useEffect(() => {
    callbacks?.onActionMount?.(
      action,
      websiteUrl ?? action.url,
      actionState.action,
    );
  }, [callbacks, action, websiteUrl, actionState]);

  const buttons = useMemo(
    () =>
      action?.actions
        .filter((it) => !it.parameter)
        .filter((it) =>
          executionState.executingAction
            ? executionState.executingAction === it
            : true,
        )
        .toSpliced(SOFT_LIMIT_BUTTONS) ?? [],
    [action, executionState.executingAction],
  );
  const inputs = useMemo(
    () =>
      action?.actions
        .filter((it) => it.parameter)
        .filter((it) =>
          executionState.executingAction
            ? executionState.executingAction === it
            : true,
        )
        .toSpliced(SOFT_LIMIT_INPUTS) ?? [],
    [action, executionState.executingAction],
  );

  const execute = async (
    component: ActionComponent,
    params?: Record<string, string>,
  ) => {
    if (component.parameter && params) {
      component.setValue(params[component.parameter.name]);
    }

    const newActionState = getOverallActionState(action, websiteUrl);
    const newIsPassingSecurityCheck = checkSecurityFromActionState(
      newActionState,
      normalizedSecurityLevel,
    );

    // if action state has changed or origin's state has changed, and it doesn't pass the security check or became malicious, block the action
    if (
      (newActionState.action !== actionState.action ||
        newActionState.origin !== actionState.origin) &&
      !newIsPassingSecurityCheck
    ) {
      setActionState(newActionState);
      dispatch({ type: ExecutionType.BLOCK });
      return;
    }

    dispatch({ type: ExecutionType.INITIATE, executingAction: component });

    const context: ActionContext = {
      action: component.parent,
      actionType: actionState.action,
      originalUrl: websiteUrl ?? component.parent.url,
      triggeredLinkedAction: component,
    };

    try {
      const account = await action.adapter.connect(context);
      if (!account) {
        dispatch({ type: ExecutionType.RESET });
        return;
      }

      const tx = await component.post(account);
      const signResult = await action.adapter.signTransaction(
        tx.transaction,
        context,
      );

      if (!signResult || isSignTransactionError(signResult)) {
        dispatch({ type: ExecutionType.RESET });
      } else {
        await action.adapter.confirmTransaction(signResult.signature, context);
        dispatch({
          type: ExecutionType.FINISH,
          successMessage: tx.message,
        });
      }
    } catch (e) {
      dispatch({
        type: ExecutionType.FAIL,
        errorMessage: (e as Error).message ?? 'Unknown error',
      });
    }
  };

  const asButtonProps = (it: ActionComponent): ButtonProps => ({
    text: buttonLabelMap[executionState.status] ?? it.label,
    loading:
      executionState.status === 'executing' &&
      it === executionState.executingAction,
    disabled: action.disabled || executionState.status !== 'idle',
    variant: buttonVariantMap[executionState.status],
    onClick: (params?: Record<string, string>) => execute(it, params),
  });

  const asInputProps = (it: ActionComponent) => {
    return {
      // since we already filter this, we can safely assume that parameter is not null
      placeholder: it.parameter!.label,
      disabled: action.disabled || executionState.status !== 'idle',
      name: it.parameter!.name,
      button: asButtonProps(it),
    };
  };

  const disclaimer = useMemo(() => {
    if (overallState === 'malicious' && executionState.status === 'blocked') {
      return (
        <Snackbar variant="error">
          <p>
            This Action or it&apos;s origin has been flagged as an unsafe
            action, & has been blocked. If you believe this action has been
            blocked in error, please{' '}
            <a
              href="https://discord.gg/saydialect"
              className="cursor-pointer underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              submit an issue
            </a>
            .
            {!isPassingSecurityCheck &&
              ' Your action provider blocks execution of this action.'}
          </p>
          {isPassingSecurityCheck && (
            <button
              className="mt-3 font-semibold transition-colors hover:text-twitter-error-lighter motion-reduce:transition-none"
              onClick={() => dispatch({ type: ExecutionType.UNBLOCK })}
            >
              Ignore warning & proceed
            </button>
          )}
        </Snackbar>
      );
    }

    if (overallState === 'unknown') {
      return (
        <Snackbar variant="warning">
          <p>
            This Action or it&apos;s origin has not yet been registered. Only
            use it if you trust the source. It will not unfurl on X until it is
            registered.
            {!isPassingSecurityCheck &&
              ' Your action provider blocks execution of this action.'}
          </p>
          <a
            className="mt-3 inline-block font-semibold transition-colors hover:text-twitter-warning-lighter motion-reduce:transition-none"
            href="https://discord.gg/saydialect"
            target="_blank"
            rel="noopener noreferrer"
          >
            Report
          </a>
        </Snackbar>
      );
    }

    return null;
  }, [executionState.status, isPassingSecurityCheck, overallState]);

  const handleRender = () => {
    return callbacks?.onRender?.(action);
  };

  return (
    <ActionLayout
      type={overallState}
      title={action.title}
      description={action.description}
      websiteUrl={websiteUrl}
      websiteText={websiteText}
      image={action.icon}
      error={
        executionState.status !== 'success'
          ? executionState.errorMessage ?? action.error
          : null
      }
      success={executionState.successMessage}
      buttons={buttons.map(asButtonProps)}
      inputs={inputs.map(asInputProps)}
      disclaimer={disclaimer}
      onRender={callbacks?.onRender ? handleRender : null}
    />
  );
};

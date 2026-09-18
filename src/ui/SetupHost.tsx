import { createElement, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp } from 'ink';
import { getThemeColors } from '../theme.js';
import { DimensionsProvider } from './DimensionsContext.js';
import { WizardOverlay } from './overlays/WizardOverlay.js';
import type { WizardResult, WizardSpec } from './overlays/wizard-types.js';
import { runSetupFlow, type SetupOutcome } from '../setup-flow.js';

/**
 * The smallest possible Ink host: a frame, and one wizard at a time (#447).
 *
 * It exists because `bernard setup` has to work with **no API key**, which the
 * REPL cannot: `loadConfig()` throws without one and `<App>` needs a config, an
 * agent and every store to mount. A first run therefore had to be served by
 * something else, and until now that something was a `readline` prompt printed
 * before Ink ever started — which is why the first thing a new user saw looked
 * nothing like the second thing.
 *
 * It is a host, not a flow. `runSetupFlow` owns the questions, the persistence
 * and the verification; this file owns a `requestWizard` implementation and a
 * box to draw it in. `/setup` inside the REPL runs the identical flow over the
 * App's own overlay bridge.
 *
 * **Not full-screen, deliberately.** It does not enter the alternate screen
 * buffer: a fresh run continues straight into the REPL, which does, and two
 * alt-buffer entries back to back flash. Staying on the normal screen also
 * leaves the questions in scrollback, which is the right outcome for a
 * subcommand that exits when it is done.
 */

interface PendingWizard {
  spec: WizardSpec;
  resolve: (result: WizardResult) => void;
}

function SetupApp({
  onOutcome,
  verify,
}: {
  onOutcome: (o: SetupOutcome) => void;
  verify: boolean;
}) {
  const colors = getThemeColors();
  const { exit } = useApp();
  const [pending, setPending] = useState<PendingWizard | null>(null);
  const [status, setStatus] = useState('Loading your current settings…');
  const started = useRef(false);

  useEffect(() => {
    // Ink can mount an effect twice under StrictMode, and this one walks a
    // wizard and writes to disk. The ref is the guard `App.tsx` already uses for
    // its own once-per-mount onboarding effect.
    if (started.current) return;
    started.current = true;
    void (async () => {
      let outcome: SetupOutcome;
      try {
        outcome = await runSetupFlow({
          verify,
          onProgress: setStatus,
          requestWizard: (spec) =>
            new Promise<WizardResult>((resolve) => {
              setStatus('');
              setPending({ spec, resolve });
            }),
        });
      } catch (err) {
        // Reported by the caller on the restored screen, not from inside a
        // mounted renderer.
        onOutcome({ status: 'cancelled', stage: 'provider' });
        setStatus(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
        exit();
        return;
      }
      setPending(null);
      onOutcome(outcome);
      exit();
    })();
  }, [exit, onOutcome, verify]);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={pending ? 0 : 1}>
      {/* The card carries its own section and title once a wizard is up; a
          second heading above it reads as a stray line rather than a header. */}
      {pending === null && <Text color={colors.accent}>Bernard setup</Text>}
      {pending ? (
        <WizardOverlay
          spec={pending.spec}
          // This host renders nothing but the wizard, so the card centres in the
          // whole terminal.
          fill
          onResolve={(result) => {
            setPending(null);
            setStatus('Saving…');
            pending.resolve(result);
          }}
        />
      ) : (
        <Text color={colors.muted}>{status}</Text>
      )}
    </Box>
  );
}

/**
 * Mount the host, walk setup, unmount, and hand the outcome back.
 *
 * The outcome is deliberately NOT rendered here: printing it after the renderer
 * has unmounted puts it on a screen Ink no longer owns, which is the same
 * ordering `src/index.ts` keeps between `fullScreen.teardown()` and `cleanup()`.
 */
export async function runSetupHost(opts: { verify?: boolean } = {}): Promise<SetupOutcome> {
  // Ink's `useInput` puts stdin in raw mode on mount and THROWS when it cannot —
  // out of a `render()` that has already returned, so it surfaces as an
  // unhandled rejection and a React stack trace rather than anything a reader
  // can act on. Checked before mounting instead: a piped or non-TTY invocation
  // (CI, a script, `bernard setup < /dev/null`) is a legitimate thing to do and
  // deserves the one sentence that tells you what to do instead.
  if (!process.stdin.isTTY) {
    return { status: 'unavailable', reason: 'stdin is not a terminal' };
  }
  let outcome: SetupOutcome = { status: 'cancelled', stage: 'provider' };
  const { waitUntilExit } = render(
    createElement(
      DimensionsProvider,
      null,
      createElement(SetupApp, {
        verify: opts.verify !== false,
        onOutcome: (o: SetupOutcome) => {
          outcome = o;
        },
      }),
    ),
  );
  await waitUntilExit();
  return outcome;
}

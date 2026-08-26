import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { createElement } from 'react';
import { ConfirmDialog } from '../overlays/ConfirmDialog.js';
import type { BreadthOption } from '../../permissions/breadth.js';
import { ESC, ENTER, ARROW_DOWN, ARROW_LEFT, ARROW_RIGHT, CTRL_C, tick } from './_keys.js';

/** A two-step breadth ladder fixture (exact → any args). */
const BREADTH: BreadthOption[] = [
  { label: 'touch x', specifier: 'touch x', rulePreview: 'Will allow: `touch x` for this profile' },
  { label: 'touch *', specifier: 'touch *', rulePreview: 'Will allow: `touch *` for this profile' },
];

describe('<ConfirmDialog>', () => {
  describe('kind: "confirm"', () => {
    it('renders title, reason, and the three options', () => {
      const { lastFrame } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: 'rm -rf would delete files',
          risk: 'high',
          onResolve: () => {},
          onCancel: () => {},
        }),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Confirm high: shell');
      expect(frame).toContain('rm -rf would delete files');
      expect(frame).toContain('1. Allow once');
      expect(frame).toContain('2. Allow for session');
      expect(frame).toContain('3. Cancel');
    });

    it('Enter on default highlight resolves allow-once', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 't',
          reason: 'r',
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true, 'once', undefined);
    });

    it('Down + Enter resolves allow-session', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 't',
          reason: 'r',
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_DOWN);
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true, 'session', undefined);
    });

    it('Down x2 + Enter resolves cancel (deny)', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 't',
          reason: 'r',
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_DOWN);
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith(false, 'once', undefined);
    });

    it('digit shortcut commits matching choice', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 't',
          reason: 'r',
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write('2');
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true, 'session', undefined);
    });

    it('Esc and Ctrl-C call onCancel', async () => {
      for (const keystroke of [ESC, CTRL_C]) {
        const onCancel = vi.fn();
        const { stdin } = render(
          createElement(ConfirmDialog, {
            kind: 'confirm',
            toolName: 't',
            reason: 'r',
            onResolve: () => {},
            onCancel,
          }),
        );
        await tick();
        stdin.write(keystroke);
        await tick();
        expect(onCancel).toHaveBeenCalledTimes(1);
      }
    });

    it('falls back to "action" label when no risk is provided', () => {
      const { lastFrame } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: 'r',
          onResolve: () => {},
          onCancel: () => {},
        }),
      );
      expect(lastFrame()).toContain('Confirm action: shell');
    });
  });

  describe('kind: "block"', () => {
    it('renders the read-only mode banner and block-mode labels', () => {
      const { lastFrame } = render(
        createElement(ConfirmDialog, {
          kind: 'block',
          toolName: 'file_write',
          reason: 'read-only mode blocks this',
          onResolve: () => {},
          onCancel: () => {},
        }),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Blocked (read-only mode): file_write');
      expect(frame).toContain('1. Allow once');
      expect(frame).toContain('2. Enable for this tool, this session');
      expect(frame).toContain('3. Deny');
    });

    it('Enter commits allow-once', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'block',
          toolName: 't',
          reason: 'r',
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith('allow-once', undefined);
    });

    it('Down + Enter commits allow-tool-for-session', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'block',
          toolName: 't',
          reason: 'r',
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_DOWN);
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith('allow-tool-for-session', undefined);
    });

    it('Down x2 + Enter commits deny', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'block',
          toolName: 't',
          reason: 'r',
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_DOWN);
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith('deny', undefined);
    });
  });

  describe('profile grants (#212/#261, breadthOptions set)', () => {
    it('confirm kind renders the profile choice with the command label and shell header tag', () => {
      const { lastFrame } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: '$ touch x',
          risk: 'high',
          permissionKey: 'shell:touch',
          breadthOptions: [
            {
              label: 'touch',
              specifier: 'touch *',
              rulePreview: 'Will allow: `touch` for this profile',
            },
          ],
          onResolve: () => {},
          onCancel: () => {},
        }),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Confirm high: shell (touch)');
      expect(frame).toContain('3. Always allow `touch` for this profile');
      expect(frame).toContain('4. Cancel');
    });

    it('confirm kind: Down x2 + Enter resolves profile scope with the selected breadth', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: 'r',
          breadthOptions: BREADTH,
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_DOWN);
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true, 'profile', BREADTH[0]);
    });

    it('confirm kind: Down x3 + Enter still reaches Cancel', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: 'r',
          breadthOptions: BREADTH,
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_DOWN);
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith(false, 'once', undefined);
    });

    it('confirm kind: digit 3 commits the profile choice', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: 'r',
          breadthOptions: BREADTH,
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write('3');
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true, 'profile', BREADTH[0]);
    });

    it('block kind: Down x2 + Enter commits allow-tool-for-profile; Deny moves to 4', async () => {
      const onResolve = vi.fn();
      const { stdin, lastFrame } = render(
        createElement(ConfirmDialog, {
          kind: 'block',
          toolName: 'shell',
          reason: '$ touch x',
          permissionKey: 'shell:touch',
          breadthOptions: BREADTH,
          onResolve,
          onCancel: () => {},
        }),
      );
      expect(lastFrame()).toContain('4. Deny');
      await tick();
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_DOWN);
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith('allow-tool-for-profile', BREADTH[0]);
    });

    it('absent breadthOptions keeps the historic 3-choice list (no profile row)', () => {
      const { lastFrame } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: '$ touch x; rm -rf /',
          risk: 'high',
          permissionKey: null,
          onResolve: () => {},
          onCancel: () => {},
        }),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('3. Cancel');
      expect(frame).not.toContain('for this profile');
    });
  });

  describe('breadth axis (#261)', () => {
    it('→ on the profile row broadens the scope passed to onResolve', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: 'r',
          breadthOptions: BREADTH,
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_DOWN); // highlight the profile row
      stdin.write(ARROW_RIGHT); // breadth 0 -> 1
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true, 'profile', BREADTH[1]);
    });

    it('← clamps at the narrowest breadth (index 0)', async () => {
      const onResolve = vi.fn();
      const { stdin } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: 'r',
          breadthOptions: BREADTH,
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_LEFT); // already at 0, clamps
      await tick();
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true, 'profile', BREADTH[0]);
    });

    it('shows the resolved rule preview while the profile row is highlighted', async () => {
      const { stdin, lastFrame } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: 'r',
          breadthOptions: BREADTH,
          onResolve: () => {},
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_DOWN);
      stdin.write(ARROW_DOWN); // highlight profile row
      await tick();
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Will allow: `touch x` for this profile');
      // Stripped: the footer routes through `HintRow` (#266), which colors the
      // key token separately from its label.
      expect(stripAnsi(frame)).toContain('←/→ scope');
    });

    it('arrows are inert and no profile row renders when breadthOptions is absent', async () => {
      const onResolve = vi.fn();
      const { stdin, lastFrame } = render(
        createElement(ConfirmDialog, {
          kind: 'confirm',
          toolName: 'shell',
          reason: 'r',
          onResolve,
          onCancel: () => {},
        }),
      );
      await tick();
      stdin.write(ARROW_RIGHT);
      stdin.write(ARROW_LEFT);
      await tick();
      expect(lastFrame() ?? '').not.toContain('for this profile');
      stdin.write(ENTER);
      await tick();
      expect(onResolve).toHaveBeenCalledWith(true, 'once', undefined);
    });
  });
});

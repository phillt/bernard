import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { ConfirmDialog } from '../overlays/ConfirmDialog.js';
import { ESC, ENTER, ARROW_DOWN, CTRL_C, tick } from './_keys.js';

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
      expect(onResolve).toHaveBeenCalledWith(true, 'once');
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
      expect(onResolve).toHaveBeenCalledWith(true, 'session');
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
      expect(onResolve).toHaveBeenCalledWith(false, 'once');
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
      expect(onResolve).toHaveBeenCalledWith(true, 'session');
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
      expect(onResolve).toHaveBeenCalledWith('allow-once');
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
      expect(onResolve).toHaveBeenCalledWith('allow-tool-for-session');
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
      expect(onResolve).toHaveBeenCalledWith('deny');
    });
  });
});

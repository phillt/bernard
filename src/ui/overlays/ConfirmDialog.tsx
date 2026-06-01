import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import type { RiskLevel } from '../../risk.js';
import type { BlockOutcome } from '../../tools/types.js';

type ConfirmChoice = 'allow-once' | 'allow-session' | 'cancel';
type BlockChoice = 'allow-once' | 'allow-tool-for-session' | 'deny';

interface ConfirmDialogPropsCommon {
  toolName: string;
  reason: string;
  onCancel: () => void;
}

interface ConfirmKindProps extends ConfirmDialogPropsCommon {
  kind: 'confirm';
  risk?: RiskLevel;
  onResolve: (allowed: boolean, scope: 'once' | 'session') => void;
}

interface BlockKindProps extends ConfirmDialogPropsCommon {
  kind: 'block';
  onResolve: (outcome: BlockOutcome) => void;
}

export type ConfirmDialogProps = ConfirmKindProps | BlockKindProps;

/**
 * Replaces the legacy three-option dialogs from `src/repl.ts`:
 *   - `kind: 'confirm'` mirrors `confirmActionFn` (risk-based, #144):
 *       "Allow once / Allow for session / Cancel"
 *   - `kind: 'block'`   mirrors `blockActionFn` (read-only mode, #179):
 *       "Allow once / Enable for this tool, this session / Deny"
 *
 * Wire-shape (props named after the tool-side callback contracts in
 * `src/tools/types.ts:58-100`) is identical to the legacy callbacks so
 * Phase D can drop the readline implementations and route to this component
 * without touching tool code.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const colors = getThemeColors();
  const choices =
    props.kind === 'confirm'
      ? (['allow-once', 'allow-session', 'cancel'] as ConfirmChoice[])
      : (['allow-once', 'allow-tool-for-session', 'deny'] as BlockChoice[]);
  const labels =
    props.kind === 'confirm'
      ? ['Allow once', 'Allow for session', 'Cancel']
      : ['Allow once', 'Enable for this tool, this session', 'Deny'];
  const [highlight, setHighlight] = useState(0);

  const commit = (idx: number) => {
    if (props.kind === 'confirm') {
      const choice = choices[idx] as ConfirmChoice;
      if (choice === 'cancel') props.onResolve(false, 'once');
      else props.onResolve(true, choice === 'allow-session' ? 'session' : 'once');
    } else {
      const choice = choices[idx] as BlockChoice;
      props.onResolve(choice);
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      props.onCancel();
      return;
    }
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      commit(highlight);
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => Math.min(choices.length - 1, h + 1));
      return;
    }
    if (/^[1-3]$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx < choices.length) commit(idx);
    }
  });

  const riskColor =
    props.kind === 'confirm' && props.risk === 'high'
      ? colors.error
      : props.kind === 'confirm' && props.risk === 'medium'
        ? colors.warning
        : colors.accent;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={riskColor} bold>
          {props.kind === 'confirm'
            ? `Confirm ${props.risk ?? 'action'}: ${props.toolName}`
            : `Blocked (read-only mode): ${props.toolName}`}
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text>{props.reason}</Text>
      </Box>
      <Text> </Text>
      {labels.map((label, idx) => {
        const isHighlighted = idx === highlight;
        return (
          <Box key={idx}>
            <Text color={colors.accent}>{isHighlighted ? '> ' : '  '}</Text>
            <Text bold={isHighlighted} color={isHighlighted ? colors.accent : undefined}>
              {idx + 1}. {label}
            </Text>
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor>↑/↓ move · Enter select · Esc cancel</Text>
    </Box>
  );
}

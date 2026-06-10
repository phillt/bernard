import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import type { RiskLevel } from '../../risk.js';
import type { BlockOutcome } from '../../tools/types.js';
import { permissionKeyLabel } from '../../tool-permissions.js';
import { MenuRow } from './MenuRow.js';

type ConfirmChoice = 'allow-once' | 'allow-session' | 'allow-profile' | 'cancel';
type BlockChoice = BlockOutcome;

interface ConfirmDialogPropsCommon {
  toolName: string;
  reason: string;
  onCancel: () => void;
  /**
   * Profile-grant key for this call (#212). When non-null, an
   * "Always allow … for this profile" choice is appended; `null`/`undefined`
   * (complex shell commands, legacy callers) keeps the historic 3-choice
   * list.
   */
  permissionKey?: string | null;
}

interface ConfirmKindProps extends ConfirmDialogPropsCommon {
  kind: 'confirm';
  risk?: RiskLevel;
  onResolve: (allowed: boolean, scope: 'once' | 'session' | 'profile') => void;
}

interface BlockKindProps extends ConfirmDialogPropsCommon {
  kind: 'block';
  onResolve: (outcome: BlockOutcome) => void;
}

export type ConfirmDialogProps = ConfirmKindProps | BlockKindProps;

/**
 * Replaces the legacy three-option dialogs from `src/repl.ts`:
 *   - `kind: 'confirm'` mirrors `confirmActionFn` (risk-based, #144):
 *       "Allow once / Allow for session / [Always allow for this profile] / Cancel"
 *   - `kind: 'block'`   mirrors `blockActionFn` (read-only mode, #179):
 *       "Allow once / Enable for this tool, this session / [Always allow for this profile] / Deny"
 *
 * The bracketed profile choice (#212) appears only when `permissionKey` is
 * set — the augment layer passes `shell:<primary>` for simple shell commands
 * and the tool name otherwise; complex shell lines carry `null` and keep the
 * historic 3-choice list.
 *
 * Wire-shape (props named after the tool-side callback contracts in
 * `src/tools/types.ts`) is identical to the legacy callbacks so Phase D can
 * drop the readline implementations and route to this component without
 * touching tool code.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const colors = getThemeColors();
  const keyLabel = props.permissionKey ? permissionKeyLabel(props.permissionKey) : null;
  const profileLabel = keyLabel ? `Always allow \`${keyLabel}\` for this profile` : null;
  // Choice/label pairs assembled together so the two can't drift.
  const rows: Array<{ choice: ConfirmChoice | BlockChoice; label: string }> =
    props.kind === 'confirm'
      ? [
          { choice: 'allow-once', label: 'Allow once' },
          { choice: 'allow-session', label: 'Allow for session' },
          ...(profileLabel ? [{ choice: 'allow-profile' as const, label: profileLabel }] : []),
          { choice: 'cancel', label: 'Cancel' },
        ]
      : [
          { choice: 'allow-once', label: 'Allow once' },
          { choice: 'allow-tool-for-session', label: 'Enable for this tool, this session' },
          ...(profileLabel
            ? [{ choice: 'allow-tool-for-profile' as const, label: profileLabel }]
            : []),
          { choice: 'deny', label: 'Deny' },
        ];
  const choices = rows.map((r) => r.choice);
  const labels = rows.map((r) => r.label);
  const [highlight, setHighlight] = useState(0);

  const commit = (idx: number) => {
    if (props.kind === 'confirm') {
      const choice = choices[idx] as ConfirmChoice;
      if (choice === 'cancel') props.onResolve(false, 'once');
      else if (choice === 'allow-profile') props.onResolve(true, 'profile');
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
    if (/^[1-9]$/.test(input)) {
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

  // Command-level header framing (#212): `shell (touch)` instead of bare
  // `shell` when the permission key carries a primary command — the label
  // differs from the raw key exactly when a `shell:` prefix was stripped.
  const toolLabel =
    keyLabel && keyLabel !== props.permissionKey
      ? `${props.toolName} (${keyLabel})`
      : props.toolName;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={riskColor} bold>
          {props.kind === 'confirm'
            ? `Confirm ${props.risk ?? 'action'}: ${toolLabel}`
            : `Blocked (read-only mode): ${toolLabel}`}
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text>{props.reason}</Text>
      </Box>
      <Text> </Text>
      {labels.map((label, idx) => (
        <MenuRow key={idx} selected={idx === highlight} label={`${idx + 1}. ${label}`} />
      ))}
      <Text> </Text>
      <Text dimColor>↑/↓ move · Enter select · Esc cancel</Text>
    </Box>
  );
}

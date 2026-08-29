import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import { HintRow, KEY, HINT_MOVE, HINT_SELECT, HINT_CANCEL } from '../hints.js';
import { isDismissKeyWithQ } from './overlay-contract.js';
import { useListCursor } from './use-list-cursor.js';
import { clamp } from './viewer-util.js';
import type { RiskLevel } from '../../risk.js';
import type { BlockOutcome } from '../../tools/types.js';
import { permissionKeyLabel } from '../../tool-permissions.js';
import type { BreadthOption } from '../../permissions/breadth.js';
import { MenuRow } from './MenuRow.js';

type ConfirmChoice = 'allow-once' | 'allow-session' | 'allow-profile' | 'cancel';
type BlockChoice = BlockOutcome;

interface ConfirmDialogPropsCommon {
  toolName: string;
  reason: string;
  onCancel: () => void;
  /**
   * Profile-grant key for this call (#212), used only for the command-level
   * header framing (`shell (touch)`).
   */
  permissionKey?: string | null;
  /**
   * Scope/breadth ladder (#261): ordered narrow→broad options the user cycles
   * with ←/→. When non-empty, the "Always allow … for this profile" choice is
   * offered (its label reflects the selected breadth). Empty/absent ⇒ no
   * profile row (dangerous/complex shell).
   */
  breadthOptions?: BreadthOption[];
  /** Initial breadth selection (default 0 = narrowest = today's behavior). */
  initialBreadthIndex?: number;
}

interface ConfirmKindProps extends ConfirmDialogPropsCommon {
  kind: 'confirm';
  risk?: RiskLevel;
  onResolve: (
    allowed: boolean,
    scope: 'once' | 'session' | 'profile',
    breadth: BreadthOption | undefined,
  ) => void;
}

interface BlockKindProps extends ConfirmDialogPropsCommon {
  kind: 'block';
  onResolve: (outcome: BlockOutcome, breadth: BreadthOption | undefined) => void;
}

export type ConfirmDialogProps = ConfirmKindProps | BlockKindProps;

/**
 * Risk/read-only confirmation dialog with two orthogonal axes (#144/#179/#261):
 *   - ↑/↓ = **duration**: Allow once / for session / [for this profile] / Cancel
 *   - ←/→ = **breadth**:  this exact call → this command/tool with any args
 *
 * The profile choice (and the breadth axis) appear only when `breadthOptions`
 * is non-empty — the augment layer omits them for dangerous/complex shell, so
 * a breadth grant can never silence a dangerous invocation. Picking a profile
 * grant persists a `PermissionRule` built from the selected breadth.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const colors = getThemeColors();
  const breadthOptions = props.breadthOptions ?? [];
  const hasBreadth = breadthOptions.length > 0;
  const [breadthIdx, setBreadthIdx] = useState(
    Math.min(Math.max(props.initialBreadthIndex ?? 0, 0), Math.max(breadthOptions.length - 1, 0)),
  );
  const breadth = hasBreadth ? breadthOptions[breadthIdx] : undefined;
  const profileLabel = breadth ? `Always allow \`${breadth.label}\` for this profile` : null;

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

  const commit = (idx: number) => {
    if (props.kind === 'confirm') {
      const choice = choices[idx] as ConfirmChoice;
      if (choice === 'cancel') props.onResolve(false, 'once', undefined);
      else if (choice === 'allow-profile') props.onResolve(true, 'profile', breadth);
      else props.onResolve(true, choice === 'allow-session' ? 'session' : 'once', undefined);
    } else {
      const choice = choices[idx] as BlockChoice;
      const isProfile = choice === 'allow-tool-for-profile';
      props.onResolve(choice, isProfile ? breadth : undefined);
    }
  };

  // The ←/→ KEYMAP is shared (`horizontal: 'axis'`); the state it drives is not.
  // `breadthIdx` / `breadthOptions` / `hasBreadth` are permission-domain
  // semantics with exactly one consumer, so they stay here — the shared module
  // only answers "the user pressed the second axis, by this much".
  const { index: highlight, handleKey } = useListCursor({
    total: choices.length,
    onCommit: commit,
    horizontal: hasBreadth ? 'axis' : 'none',
    onAxis: (delta) => setBreadthIdx((b) => clamp(b + delta, 0, breadthOptions.length - 1)),
  });

  useInput((input, key) => {
    // Gains `q` from the shared contract (#266) — this dialog has no text
    // field, and `q` cancels, i.e. it resolves toward denial. Safe direction.
    // Dismissal is tested first, ahead of the list keystream, so the precedence
    // stays a readable if-chain rather than a `useInput` registration order.
    if (isDismissKeyWithQ(input, key)) {
      props.onCancel();
      return;
    }
    handleKey(input, key);
  });

  const riskColor =
    props.kind === 'confirm' && props.risk === 'high'
      ? colors.error
      : props.kind === 'confirm' && props.risk === 'medium'
        ? colors.warning
        : colors.accent;

  const keyLabel = props.permissionKey ? permissionKeyLabel(props.permissionKey) : null;
  // Command-level header framing (#212): `shell (touch)` instead of bare
  // `shell` when the permission key carries a primary command.
  const toolLabel =
    keyLabel && keyLabel !== props.permissionKey
      ? `${props.toolName} (${keyLabel})`
      : props.toolName;

  // The profile row's index (if present) so we can show the breadth selector
  // only while it's highlighted.
  const profileRowIdx = choices.findIndex(
    (c) => c === 'allow-profile' || c === 'allow-tool-for-profile',
  );
  const showBreadth = hasBreadth && highlight === profileRowIdx;

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
      {showBreadth && breadth ? (
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Text color={colors.accent}>
            {breadthOptions.length > 1
              ? `← scope: ${breadth.label} →  (${breadthIdx + 1}/${breadthOptions.length})`
              : `scope: ${breadth.label}`}
          </Text>
          <Text dimColor>{breadth.rulePreview}</Text>
        </Box>
      ) : null}
      <Text> </Text>
      <HintRow
        hints={[
          HINT_MOVE,
          ...(hasBreadth ? [{ key: KEY.leftRight, label: 'scope' }] : []),
          HINT_SELECT,
          HINT_CANCEL,
        ]}
      />
    </Box>
  );
}

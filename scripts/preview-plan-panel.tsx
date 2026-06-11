/**
 * TEMP design preview — Plan panel restyle exploration.
 *
 * Renders four candidate designs for the pinned plan panel, each shown sitting
 * directly above a mock of the real `<Prompt>` input box (round border, accent
 * color) so you can judge how well each "extends" the input box.
 *
 * Run:  npx tsx scripts/preview-plan-panel.tsx [theme]
 *   theme defaults to `synthwave` (the purple in your screenshot).
 *   e.g.  npx tsx scripts/preview-plan-panel.tsx bernard
 *
 * Press any key to exit. This file is throwaway — delete once a design is picked.
 */
import React, { createElement } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { getThemeColors, setTheme, type ThemeColors } from '../src/theme.js';

type StepStatus = 'done' | 'in_progress' | 'pending' | 'error';
interface Step {
  id: number;
  description: string;
  status: StepStatus;
  note?: string;
}

const STEPS: Step[] = [
  {
    id: 1,
    description: "Find recent authoritative sources on string theory's current status in physics research",
    status: 'done',
  },
  {
    id: 2,
    description: 'Find authoritative explanations of why extra dimensions are hard to prove experimentally',
    status: 'in_progress',
  },
  {
    id: 3,
    description: 'Synthesize a concise answer to both user questions with citations',
    status: 'pending',
  },
];

const PANEL_WIDTH = 78;

function stepIcon(status: StepStatus, colors: ThemeColors): { icon: string; color?: string } {
  switch (status) {
    case 'done':
      return { icon: '✔', color: colors.success };
    case 'error':
      return { icon: '✘', color: colors.error };
    case 'in_progress':
      return { icon: '▸', color: colors.accent };
    case 'pending':
      return { icon: '○' };
  }
}

/**
 * The step rows. Wrap (no truncation) with a hanging indent: a fixed-width
 * `{icon} {id}.` gutter (flexShrink=0) and a flex description column that wraps,
 * so continuation lines align under the description start.
 */
function StepRows({ colors, pad = 1 }: { colors: ThemeColors; pad?: number }) {
  // Fixed-width gutter cells so the description column aligns across rows and is
  // deterministic regardless of how the terminal measures the status glyph.
  const maxIdLen = Math.max(...STEPS.map((s) => String(s.id).length));
  const idCellWidth = maxIdLen + 2; // "<id>. "
  return (
    <Box flexDirection="column" paddingLeft={pad} paddingRight={1}>
      {STEPS.map((step) => {
        const { icon, color } = stepIcon(step.status, colors);
        const active = step.status === 'in_progress';
        const pending = step.status === 'pending';
        return (
          <Box key={step.id}>
            <Box width={2} flexShrink={0}>
              <Text color={color} dimColor={!color}>
                {icon}
              </Text>
            </Box>
            <Box width={idCellWidth} flexShrink={0}>
              <Text dimColor={pending}>{step.id}. </Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="wrap" bold={active} dimColor={pending}>
                {step.description}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** Mock of the real <Prompt> input box (round border, accent, `›` cursor). */
function InputBox({
  colors,
  borderTop = true,
  roundTop = true,
}: {
  colors: ThemeColors;
  borderTop?: boolean;
  roundTop?: boolean;
}) {
  return (
    <Box
      width={PANEL_WIDTH}
      borderStyle={roundTop ? 'round' : 'single'}
      borderTop={borderTop}
      borderColor={colors.accent}
      paddingX={1}
    >
      <Text>
        <Text color={colors.accent} bold>
          {'› '}
        </Text>
        <Text dimColor>ask bernard anything…</Text>
      </Text>
    </Box>
  );
}

function Header({ colors, glyph = '◇' }: { colors: ThemeColors; glyph?: string }) {
  const done = STEPS.filter((s) => s.status === 'done').length;
  return (
    <Text>
      <Text color={colors.accent} bold>
        {glyph} plan
      </Text>
      <Text dimColor>
        {' '}
        {done}/{STEPS.length}
      </Text>
    </Text>
  );
}

function Label({ colors, n, title, desc }: { colors: ThemeColors; n: number; title: string; desc: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={colors.accent} bold>
          {'  ── '}
        </Text>
        <Text bold>
          Variant {n}: {title}
        </Text>
      </Text>
      <Text dimColor>{'     ' + desc}</Text>
    </Box>
  );
}

// ── Variant 1: Unified single box ───────────────────────────────────────────
// Plan + input live inside ONE round box with an interior divider. Literally
// the input box extended upward to swallow the plan. Strongest "extension".
function Variant1({ colors }: { colors: ThemeColors }) {
  return (
    <Box width={PANEL_WIDTH} flexDirection="column" borderStyle="round" borderColor={colors.accent}>
      <Box paddingX={1}>
        <Header colors={colors} />
      </Box>
      <StepRows colors={colors} pad={2} />
      {/* interior full-width divider */}
      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor={colors.accent} borderDimColor />
      <Box paddingX={1}>
        <Text>
          <Text color={colors.accent} bold>
            {'› '}
          </Text>
          <Text dimColor>ask bernard anything…</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ── Variant 2: Connected container (open-bottom plan, flush on the input) ────
// Plan in a round box with its bottom edge removed so it sits flush on top of
// the full input box — reads as one tall container split into two zones.
function Variant2({ colors }: { colors: ThemeColors }) {
  return (
    <Box flexDirection="column">
      <Box
        width={PANEL_WIDTH}
        flexDirection="column"
        borderStyle="round"
        borderBottom={false}
        borderColor={colors.accent}
        paddingX={1}
      >
        <Header colors={colors} />
        <StepRows colors={colors} pad={1} />
      </Box>
      <InputBox colors={colors} roundTop={false} />
    </Box>
  );
}

// ── Variant 3: Left accent rail (no buns) ───────────────────────────────────
// Drops both horizontal rules. A single vertical accent bar runs down the
// steps, echoing the input box's accent without boxing the plan in.
function Variant3({ colors }: { colors: ThemeColors }) {
  return (
    <Box flexDirection="column">
      <Box marginLeft={1} marginBottom={0}>
        <Header colors={colors} glyph="│" />
      </Box>
      <Box
        borderStyle="round"
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        borderColor={colors.accent}
        paddingLeft={1}
        width={PANEL_WIDTH}
      >
        <StepRows colors={colors} pad={1} />
      </Box>
      <Box marginTop={0}>
        <InputBox colors={colors} />
      </Box>
    </Box>
  );
}

// ── Variant 4: Rounded sibling card ─────────────────────────────────────────
// Plan gets its own complete round box (dim accent border) above the input —
// two cards sharing the same shape/accent, separated by one blank line.
function Variant4({ colors }: { colors: ThemeColors }) {
  return (
    <Box flexDirection="column">
      <Box
        width={PANEL_WIDTH}
        flexDirection="column"
        borderStyle="round"
        borderColor={colors.accent}
        borderDimColor
        paddingX={1}
      >
        <Header colors={colors} />
        <StepRows colors={colors} pad={1} />
      </Box>
      <Box marginTop={1}>
        <InputBox colors={colors} />
      </Box>
    </Box>
  );
}

// ── Current (for comparison) ────────────────────────────────────────────────
function Current({ colors }: { colors: ThemeColors }) {
  const rule = (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor={colors.muted} width={PANEL_WIDTH} />
  );
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginLeft={2}>
        <Header colors={colors} glyph="" />
        {rule}
        <StepRows colors={colors} pad={1} />
        {rule}
      </Box>
      <Box marginTop={1}>
        <InputBox colors={colors} />
      </Box>
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  useInput(() => exit(), { isActive: process.stdin.isTTY === true });
  const colors = getThemeColors();
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>Plan panel — design exploration (theme: {process.argv[2] ?? 'synthwave'})</Text>

      <Label colors={colors} n={0} title="Current" desc="two horizontal rules ('buns') — the thing we're replacing" />
      <Current colors={colors} />

      <Label colors={colors} n={1} title="Unified single box" desc="plan + input share ONE round box with an interior divider — the input box extended upward" />
      <Variant1 colors={colors} />

      <Label colors={colors} n={2} title="Connected container" desc="open-bottom plan box sits flush on top of the input box — one tall split container" />
      <Variant2 colors={colors} />

      <Label colors={colors} n={3} title="Left accent rail" desc="no rules; a vertical accent bar runs down the steps, then the input box below" />
      <Variant3 colors={colors} />

      <Label colors={colors} n={4} title="Rounded sibling card" desc="plan in its own dim round box matching the input's shape, one blank line apart" />
      <Variant4 colors={colors} />

      <Box marginTop={1}>
        <Text dimColor>press any key to exit</Text>
      </Box>
    </Box>
  );
}

setTheme(process.argv[2] ?? 'synthwave');
render(createElement(App));

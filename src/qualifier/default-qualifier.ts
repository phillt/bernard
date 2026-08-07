import {
  bloomLevel,
  bloomNeedsCoordinator,
  hasAgenticActionRequest,
  hasMultiStepLanguage,
  hasReasoningRequest,
  hasToolInvocationKeyword,
  subQuestionCount,
  tokenCount,
  TOKEN_LOW,
} from './signals.js';
import type { Qualifier, QualificationInput, QualificationResult } from './types.js';

/**
 * v1 rule-based qualifier (#167). Decision tree, ordered so the
 * highest-signal gate (tool-invocation keywords) wins first. The default for
 * ambiguous middle-band asks is `'normal'` — mirroring FrugalGPT's
 * "try the cheap path first" cascade rather than RouteLLM's preference
 * threshold (which we can't train without telemetry yet).
 *
 * The chosen `reason` is a kebab-case code naming the strongest signal so
 * `debugLog('policy:decide', …)` is greppable.
 */
export class DefaultQualifier implements Qualifier {
  qualify(input: QualificationInput): QualificationResult {
    const text = input.userText ?? '';
    const tokens = tokenCount(text);
    const toolKw = hasToolInvocationKeyword(text);
    const multiStep = hasMultiStepLanguage(text);
    const agenticAction = hasAgenticActionRequest(text);
    const questions = subQuestionCount(text);
    const reasoning = hasReasoningRequest(text);
    const bloom = bloomLevel(text);
    const bloomEscalates = bloomNeedsCoordinator(bloom);

    const signals: Record<string, boolean | number | string> = {
      tokens,
      toolKw,
      multiStep,
      agenticAction,
      questions,
      reasoning,
      bloom,
    };

    // Pure-question gate: a short ask that ends in `?` and contains no
    // multi-step or multi-question signals shouldn't escalate purely on
    // broad-verb overlap ("what format should I use?" trips both tool-kw
    // 'format' and bloom-apply 'use' but is a single trivial question).
    // Below TOKEN_LOW with exactly 1 question and no multi-step structure
    // → bypass the tool-kw / bloom escalations and fall through to the
    // light-path branch.
    const isPureShortQuestion = questions === 1 && tokens < TOKEN_LOW && !multiStep;

    // Escalation gates — any one hit promotes the turn to react. Ordered
    // so the strongest / most distinctive signal names the reason.
    if (multiStep) {
      return { strategyId: 'react', reason: 'qualifier:multi-step-language', signals };
    }
    // Real-world action on the user's behalf (message a person, book/refill,
    // submit a form). Inherently sustained tool work — escalate regardless of
    // length so it gets ReAct's larger step budget + plan enforcement rather
    // than Normal's tight ceiling. A short, conversational "reach out to my
    // doctor about a refill" otherwise falls through to short-and-simple.
    if (agenticAction) {
      return { strategyId: 'react', reason: 'qualifier:agentic-action', signals };
    }
    if (!isPureShortQuestion && toolKw && (bloomEscalates || tokens > TOKEN_LOW)) {
      // Pure tool-keyword on a short ask ("run ls") doesn't need coordinator;
      // require either Apply/Analyze/Evaluate framing or non-trivial length.
      return { strategyId: 'react', reason: 'qualifier:tool-keyword-and-complexity', signals };
    }
    if (questions >= 2) {
      return { strategyId: 'react', reason: 'qualifier:multiple-questions', signals };
    }
    if (!isPureShortQuestion && bloomEscalates) {
      return { strategyId: 'react', reason: `qualifier:bloom-${bloom}`, signals };
    }

    // Safe-light path: short, no tool keywords, no reasoning request, ≤1 question.
    if (tokens < TOKEN_LOW && !toolKw && !reasoning && questions <= 1) {
      return { strategyId: 'normal', reason: 'qualifier:short-and-simple', signals };
    }

    // Middle band — default to normal per FrugalGPT cascade design.
    return { strategyId: 'normal', reason: 'qualifier:default-light', signals };
  }
}

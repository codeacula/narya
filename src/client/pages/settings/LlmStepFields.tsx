import React from 'react';
import type { ActionStepInput, LlmExample, LlmSystemPromptMode } from '../../../shared/api';
import {
  MAX_LLM_CHAT_HISTORY_LINES,
  MAX_LLM_EXAMPLE_LENGTH,
  MAX_LLM_EXAMPLES,
  MAX_LLM_INTERACTION_HISTORY,
  MAX_LLM_SYSTEM_PROMPT_LENGTH,
} from '../../../shared/api';
import { addProfileTag } from '../../../shared/viewerTags';
import { Icon } from '../../ui/icons';

type LlmStep = Extract<ActionStepInput, { type: 'llm_response' }>;

/**
 * The chip editor from the Viewer Profile modal, reused so a tag typed here looks and
 * normalizes exactly like one typed there — the gate compares them, so they must agree.
 */
function TagGate({
  label,
  sub,
  tags,
  disabled,
  onChange,
}: {
  label: string;
  sub: string;
  tags: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = React.useState('');

  const commit = (value: string) => {
    const next = addProfileTag(tags, value);
    if (next !== tags) onChange(next);
    setDraft('');
  };

  return (
    <label className="field settings-wide-field">
      <span>{label}</span>
      {tags.length > 0 && (
        <div className="tag-chip-list">
          {tags.map(tag => (
            <span className="tag-chip" key={tag}>
              {tag}
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                disabled={disabled}
                onClick={() => onChange(tags.filter(item => item !== tag))}
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={draft}
        disabled={disabled}
        placeholder="Type a tag and press Enter"
        onChange={event => setDraft(event.target.value)}
        onBlur={() => { if (draft.trim()) commit(draft); }}
        onKeyDown={event => {
          if (event.key !== 'Enter') return;
          // The step editor sits inside a form; Enter must add a tag, not submit it.
          event.preventDefault();
          if (draft.trim()) commit(draft);
        }}
      />
      <small className="action-hint">{sub}</small>
    </label>
  );
}

export function LlmStepFields({
  step,
  disabled,
  onChange,
}: {
  step: LlmStep;
  disabled: boolean;
  onChange: (next: ActionStepInput) => void;
}): React.ReactElement {
  const patch = (fields: Partial<LlmStep['payload']>) =>
    onChange({ ...step, payload: { ...step.payload, ...fields } });

  const setExample = (index: number, fields: Partial<LlmExample>) => {
    patch({ examples: step.payload.examples.map((pair, i) => (i === index ? { ...pair, ...fields } : pair)) });
  };

  return (
    <>
      <label className="field settings-wide-field">
        <span>Prompt</span>
        <input
          value={step.payload.template}
          disabled={disabled}
          maxLength={500}
          placeholder="Answer {actor} in one sentence: {input}"
          onChange={event => patch({ template: event.target.value })}
        />
        <small className="action-hint">
          Tokens: {'{actor} {login} {input} {role} {tags} {arg1} {rest}'}
        </small>
      </label>

      <div className="action-step-group">Persona</div>

      <label className="field settings-wide-field">
        <span>System prompt</span>
        <textarea
          value={step.payload.systemPrompt}
          disabled={disabled}
          rows={3}
          maxLength={MAX_LLM_SYSTEM_PROMPT_LENGTH}
          placeholder="If they are a moderator, answer briefly and defer to them."
          onChange={event => patch({ systemPrompt: event.target.value })}
        />
        <small className="action-hint">
          Leave empty to use the personality prompt from Settings &rarr; LLM on its own.
        </small>
      </label>

      <label className="field">
        <span>Combine with personality</span>
        <select
          value={step.payload.systemPromptMode}
          disabled={disabled}
          onChange={event => patch({ systemPromptMode: event.target.value as LlmSystemPromptMode })}
        >
          <option value="enhance">Enhance &mdash; add to the personality prompt</option>
          <option value="override">Override &mdash; replace it entirely</option>
        </select>
      </label>

      <div className="action-step-group">Context</div>

      <label className="field">
        <span>Recent chat lines</span>
        <input
          type="number"
          min={0}
          max={MAX_LLM_CHAT_HISTORY_LINES}
          value={step.payload.chatHistoryLines}
          disabled={disabled}
          onChange={event => patch({ chatHistoryLines: Math.trunc(Number(event.target.value)) || 0 })}
        />
        <small className="action-hint">0 sends none. Moderated messages are never included.</small>
      </label>

      <label className="field">
        <span>Prior exchanges</span>
        <input
          type="number"
          min={0}
          max={MAX_LLM_INTERACTION_HISTORY}
          value={step.payload.interactionHistory}
          disabled={disabled}
          onChange={event => patch({ interactionHistory: Math.trunc(Number(event.target.value)) || 0 })}
        />
        <small className="action-hint">
          Replays this viewer&apos;s last exchanges with the bot. 0 sends none.
        </small>
      </label>

      <div className="action-step-group">Examples</div>

      {step.payload.examples.map((pair, index) => (
        <label className="field settings-wide-field" key={index}>
          <span>Example {index + 1}</span>
          <div className="llm-example-row">
            <input
              value={pair.input}
              disabled={disabled}
              maxLength={MAX_LLM_EXAMPLE_LENGTH}
              placeholder="What a viewer says"
              onChange={event => setExample(index, { input: event.target.value })}
            />
            <input
              value={pair.output}
              disabled={disabled}
              maxLength={MAX_LLM_EXAMPLE_LENGTH}
              placeholder="How the bot should answer"
              onChange={event => setExample(index, { output: event.target.value })}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove example ${index + 1}`}
              disabled={disabled}
              onClick={() => patch({ examples: step.payload.examples.filter((_, i) => i !== index) })}
            >
              <Icon name="x" />
            </button>
          </div>
        </label>
      ))}
      {step.payload.examples.length < MAX_LLM_EXAMPLES && (
        <div className="settings-wide-field">
          <button
            type="button"
            className="modbtn"
            disabled={disabled}
            onClick={() => patch({ examples: [...step.payload.examples, { input: '', output: '' }] })}
          >
            Add example
          </button>
        </div>
      )}

      <div className="action-step-group">Targeting</div>

      <TagGate
        label="Only these tags"
        sub="Leave empty to allow everyone. A run with no viewer is excluded when this is set."
        tags={step.payload.allowTags}
        disabled={disabled}
        onChange={allowTags => patch({ allowTags })}
      />
      <TagGate
        label="Never these tags"
        sub="Wins over the allow list. The step is skipped and the model is never called."
        tags={step.payload.denyTags}
        disabled={disabled}
        onChange={denyTags => patch({ denyTags })}
      />

      <div className="action-step-group">Reply</div>

      <label className="field">
        <span>May decline</span>
        <select
          value={step.payload.allowDecline ? 'yes' : 'no'}
          disabled={disabled}
          onChange={event => patch({ allowDecline: event.target.value === 'yes' })}
        >
          <option value="no">Always reply</option>
          <option value="yes">Let the model stay silent</option>
        </select>
        <small className="action-hint">Asks for a JSON reply so it can choose not to answer.</small>
      </label>

      <label className="field">
        <span>Mention the viewer</span>
        <select
          value={step.payload.mention ? 'yes' : 'no'}
          disabled={disabled}
          onChange={event => patch({ mention: event.target.value === 'yes' })}
        >
          <option value="yes">Prefix with @name</option>
          <option value="no">Send without a mention</option>
        </select>
      </label>
    </>
  );
}

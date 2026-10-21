import { describe, expect, it } from 'vitest';
import { TOOL_SPECS, argsJsonSchema } from '@src/browser-control';
import { resolveProfile } from '@src/llm';
import { compactParameters, toolsForRun } from '../tools';
import { agentSystemPrompt } from '../prompt';
import { contextThreshold } from '../elision';

function validation(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(validation);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== 'description')
      .map(([key, value]) => [key, validation(value)]),
  );
}

describe('the fixed agent tool prefix', () => {
  it('keeps every validation constraint and tool-specific help while removing duplicated conventions', () => {
    for (const spec of TOOL_SPECS.filter(tool => tool.available)) {
      const original = argsJsonSchema(spec);
      const before = JSON.stringify(original);
      expect(validation(compactParameters(original))).toEqual(validation(original));
      expect(JSON.stringify(original)).toBe(before);
    }
    const drag = toolsForRun({ vision: false }).find(tool => tool.name === 'drag')!;
    expect(JSON.stringify(drag.parameters)).toContain('Observed targets along the drag path');
  });

  it('offers the complete tool list and leaves room for page content on a 16k model', () => {
    const tools = toolsForRun({ vision: false });
    expect(tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining(['mouse_down', 'mouse_move', 'mouse_up', 'drag', 'snapshot', 'click', 'read', 'done']),
    );
    const fixed =
      agentSystemPrompt({ tools: tools.map(tool => tool.name) }).length +
      JSON.stringify(tools.map(tool => [tool.name, tool.description, tool.parameters])).length;
    const profile = resolveProfile({ kind: 'ollama', modelName: 'small', overrides: { contextWindow: 16_384 } });
    expect(fixed / 4).toBeLessThan(contextThreshold(profile) - 1_000);
  });
});

// A deterministic fixture model reads the real token from the same tool-result text a remote model receives.
import { FIXTURE_ORIGIN } from '../fixtures-config';
import { evaluate } from '../checks/helpers';
import { defineScenario, outcome } from './registry';
import { lastToolText, runAgent } from './set-f';

defineScenario({
  id: 'F-gesture-staged',
  set: 'F',
  title: 'The agent finishes a staged drag using the returned gesture token',
  covers: 'tool catalogue, model-visible token, real CDP movement, verification and stored run results',
  async run(ctx) {
    let gestureId = '';
    let value = 0;
    let tabId = 0;
    const target = { role: 'button', name: 'Flow workspace' };
    const run = await runAgent(
      ctx,
      `${FIXTURE_ORIGIN}/gestures.html`,
      async (call, index) => {
        if (index === 0) return { toolCalls: [{ id: 's', name: 'snapshot', input: {} }] };
        if (index === 1)
          return { toolCalls: [{ id: 'down', name: 'mouse_down', input: { target, offset: { x: 0.15, y: 0.4 } } }] };
        if (index === 2) {
          gestureId = /gestureId: (\S+)/.exec(lastToolText(call))?.[1] ?? '';
          if (!gestureId) throw new Error('The model did not receive the real gesture token in its tool result');
          return {
            toolCalls: [
              {
                id: 'move',
                name: 'mouse_move',
                input: { gestureId, target, offset: { x: 0.75, y: 0.6 }, durationMs: 100 },
              },
            ],
          };
        }
        if (index === 3)
          return {
            toolCalls: [{ id: 'up', name: 'mouse_up', input: { gestureId, target, offset: { x: 0.75, y: 0.6 } } }],
          };
        if (index === 4) return { toolCalls: [{ id: 'verify', name: 'snapshot', input: {} }] };
        value = await evaluate<number>(tabId, undefined, 'window.gestureFixture.nodeX');
        return {
          toolCalls: [
            { id: 'done', name: 'done', input: { outcome: 'success', summary: 'The staged drag is complete.' } },
          ],
        };
      },
      {
        beforeRun: id => {
          tabId = id;
        },
      },
    );
    const passed =
      Boolean(gestureId) &&
      value > 280 &&
      run.end.outcome === 'success' &&
      run.results.down.includes(`gestureId: ${gestureId}`) &&
      run.results.move.includes(`gestureId: ${gestureId}`) &&
      run.results.up.includes('released; gesture ended');
    return outcome(
      'the model receives one token, moves the real canvas node and releases it once',
      `outcome=${run.end.outcome}; nodeX=${value}; tokenVisible=${Boolean(gestureId)}; ${run.results.up?.split('\n').slice(0, 3).join(' | ')}`,
      passed,
    );
  },
});

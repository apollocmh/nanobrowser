import { describe, expect, it, vi } from 'vitest';
import type { AXNode } from '../perception/ax';
import { isDocumentRole } from '../perception/ax';
import { capturePartialDocumentAX, captureTier1, LEGACY_AX_LIMITS, scopeAXTree } from '../perception/capture';
import type { CdpPort, FrameRecord, TopologyPort } from '../ports';
import type { RawSnapshot } from '../perception/layout';
import { buildObservation } from '../perception/observe';
import { RefRegistry } from '../refs';

const ax = (nodeId: string, role: string, backendDOMNodeId: number, childIds: string[] = [], name = ''): AXNode => ({
  nodeId,
  ignored: false,
  role: { type: 'role', value: role },
  backendDOMNodeId,
  childIds,
  name: { type: 'computedString', value: name },
});

describe('Chrome 80 partial AX expansion', () => {
  it('joins recreated child-document AX IDs only by their original backend DOM identity', async () => {
    const responses: Record<number, AXNode[]> = {
      45: [ax('39', 'generic', 8, ['40', '41']), ax('36', 'WebArea', 45, ['39'], 'Inner')],
      8: [
        ax('49', 'button', 7, ['55'], 'Inner action'),
        ax('50', 'status', 55, ['56']),
        ax('46', 'generic', 8, ['49', '50']),
        ax('48', 'WebArea', 45, ['46'], 'Inner'),
      ],
      7: [
        ax('71', 'StaticText', 70, [], 'Inner action'),
        ax('65', 'button', 7, ['71'], 'Inner action'),
        ax('66', 'generic', 8, ['65']),
        ax('68', 'WebArea', 45, ['66'], 'Inner'),
      ],
      55: [
        ax('81', 'StaticText', 80, [], 'Ready'),
        ax('75', 'status', 55, ['81']),
        ax('76', 'generic', 8, ['75']),
        ax('78', 'WebArea', 45, ['76'], 'Inner'),
      ],
    };
    const send = vi.fn(async (_session, _method, params) => ({ nodes: responses[params.backendNodeId] }));
    const nodes = await capturePartialDocumentAX(
      { send } as unknown as CdpPort,
      undefined,
      45,
      new Set([45, 8, 7, 55, 70, 80]),
    );
    expect(nodes.map(node => node.nodeId)).toEqual(['36', '39', '49', '50', '71', '81']);
    expect(nodes.map(node => node.childIds)).toEqual([['39'], ['49', '50'], ['71'], ['81'], [], []]);
    expect(nodes.find(node => node.backendDOMNodeId === 7)?.name?.value).toBe('Inner action');
    expect(nodes.find(node => node.backendDOMNodeId === 55)?.role?.value).toBe('status');
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('keeps the inspected document and all siblings when partial ancestors contain one branch only', async () => {
    const root = ax('root', 'webArea', 10, ['group-a', 'group-b'], 'Child document');
    const groupA = ax('group-a', 'group', 11, ['button-a']);
    const groupB = ax('group-b', 'group', 12, ['button-b']);
    const nodes: Record<number, AXNode[]> = {
      10: [groupA, groupB, root, ax('outside', 'webArea', 1, ['root'], 'Main document')],
      11: [ax('button-a', 'button', 13, [], 'Alpha'), groupA, { ...root, childIds: ['group-a'] }],
      12: [ax('button-b', 'button', 14, [], 'Beta'), groupB, { ...root, childIds: ['group-b'] }],
    };
    const send = vi.fn(async (_session, method, params) => {
      expect(method).toBe('Accessibility.getPartialAXTree');
      return { nodes: nodes[params.backendNodeId] };
    });
    const result = await capturePartialDocumentAX(
      { send } as unknown as CdpPort,
      undefined,
      10,
      new Set([10, 11, 12, 13, 14]),
    );
    expect(result[0].nodeId).toBe('root');
    expect(result[0].childIds).toEqual(['group-a', 'group-b']);
    expect(result.filter(node => node.role?.value === 'button').map(node => node.name?.value)).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(result.some(node => node.nodeId === 'outside')).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('rejects incomplete unexpandable payloads rather than claiming a full capture', async () => {
    const send = vi.fn(async () => ({ nodes: [ax('root', 'webArea', 10, ['missing-child'])] }));
    await expect(capturePartialDocumentAX({ send } as unknown as CdpPort, undefined, 10)).rejects.toThrow(/incomplete/);
  });

  it('excludes a known foreign document without treating its omitted nodes as missing payloads', async () => {
    const send = vi.fn(async () => ({
      nodes: [
        ax('root', 'WebArea', 10, ['button', 'nested']),
        ax('button', 'button', 11, [], 'Action'),
        ax('nested', 'WebArea', 20, ['foreign']),
        ax('foreign', 'button', 21, [], 'Nested action'),
      ],
    }));
    const nodes = await capturePartialDocumentAX({ send } as unknown as CdpPort, undefined, 10, new Set([10, 11]));
    expect(nodes.map(node => node.nodeId)).toEqual(['root', 'button']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds a very large frame and excludes nested document roots', async () => {
    const limit = LEGACY_AX_LIMITS.maxQueries;
    LEGACY_AX_LIMITS.maxQueries = 1;
    try {
      const send = vi.fn(async () => ({
        nodes: [ax('root', 'webArea', 10, ['group']), ax('group', 'group', 11, ['button'])],
      }));
      await expect(capturePartialDocumentAX({ send } as unknown as CdpPort, undefined, 10)).rejects.toThrow(/budget/);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      LEGACY_AX_LIMITS.maxQueries = limit;
    }
    expect(
      scopeAXTree(
        [ax('root', 'RootWebArea', 1, ['child']), ax('child', 'webArea', 2, ['button']), ax('button', 'button', 3)],
        'root',
      ).map(node => node.nodeId),
    ).toEqual(['root']);
  });
});

describe('document identity validation during capture', () => {
  it('does not duplicate the main tree when an old browser ignores getFullAXTree.frameId', async () => {
    const frames: FrameRecord[] = [
      {
        frameId: 'main',
        parentFrameId: undefined,
        sessionId: undefined,
        loaderId: 'loader-main',
        url: 'https://fixture.test/',
        depth: 0,
        adFrame: false,
      },
      {
        frameId: 'child',
        parentFrameId: 'main',
        sessionId: undefined,
        loaderId: 'loader-child',
        url: 'https://fixture.test/child',
        depth: 1,
        adFrame: false,
      },
    ];
    const snapshot: RawSnapshot = {
      strings: ['main', 'child'],
      documents: [
        {
          frameId: 0,
          documentURL: 0,
          nodes: { nodeType: [9, 1, 1], backendNodeId: [1, 2, 3] },
          layout: { nodeIndex: [], styles: [], bounds: [] },
        },
        {
          frameId: 1,
          documentURL: 1,
          nodes: { nodeType: [9, 1], backendNodeId: [10, 11] },
          layout: { nodeIndex: [], styles: [], bounds: [] },
        },
      ],
    };
    const send = vi.fn(async (_session, method, params) => {
      if (method === 'DOMSnapshot.captureSnapshot') return snapshot;
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 3 };
      if (method === 'DOM.getBoxModel') return { model: { width: 200, height: 100 } };
      if (method === 'Accessibility.getFullAXTree')
        return {
          nodes: [
            ax('main', 'webArea', 1, ['button', 'iframe'], 'Main title'),
            ax('button', 'button', 2, [], 'Main action'),
            ax('iframe', 'Iframe', 3, [], 'Embedded'),
          ],
        };
      if (method === 'Accessibility.getPartialAXTree') {
        expect(params.backendNodeId).toBe(10);
        return {
          nodes: [
            ax('child-button', 'button', 11, [], 'Child action'),
            ax('child-root', 'webArea', 10, ['child-button'], 'Child title'),
          ],
        };
      }
      if (method === 'Page.getLayoutMetrics')
        return {
          cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
          cssContentSize: { width: 800, height: 600 },
        };
      return {};
    });
    const capture = await captureTier1(
      7,
      { send } as unknown as CdpPort,
      { frames: async () => frames } as TopologyPort,
      { enabledSessions: new Set() },
    );
    expect(capture.title).toBe('Main title');
    expect(capture.frames[1].status).toBe('captured');
    expect(capture.frames[1].nodes.map(node => node.name?.value)).toEqual(['Child title', 'Child action']);
    const observation = buildObservation({ ...capture, layout: undefined }, new RefRegistry('e'), {
      mode: 'all',
      budget: 30000,
    });
    expect(observation.body.match(/Main action/g)).toHaveLength(1);
    expect(observation.body.match(/Child action/g)).toHaveLength(1);
    expect(observation.body).not.toContain('webArea');
    expect(isDocumentRole('webArea')).toBe(true);
  });
});

// Records real CDP and DOM measurements; it never substitutes a DOM rectangle for an element action's identity.
import { FIXTURE_ORIGIN } from '../fixtures-config';
import { attach } from '../spike-session';
import { defineCheck } from './registry';
import { evaluate, sleep, withTab } from './helpers';

interface DomNode {
  backendNodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
}

function buttons(node: DomNode): DomNode[] {
  return [
    ...(node.nodeName === 'BUTTON' ? [node] : []),
    ...(node.children ?? []).flatMap(buttons),
    ...(node.contentDocument ? buttons(node.contentDocument) : []),
  ];
}

defineCheck({
  name: 'zoom-coordinates',
  title: 'Raw browser zoom coordinate measurements',
  description: 'Records raw and normalized metrics, quads, viewport hit tests and trusted mouse client coordinates.',
  async run(args) {
    return withTab(`${FIXTURE_ORIGIN}/compatibility.html`, async tab => {
      await chrome.tabs.setZoom(tab.tabId, Number(args.zoom ?? 1.25));
      const attachment = await attach(tab.tabId);
      await sleep(300);
      const main = (await chrome.debugger.sendCommand({ tabId: tab.tabId }, 'DOM.getDocument', {
        depth: -1,
        pierce: true,
      })) as { root: DomNode };
      const nodes = buttons(main.root);
      const measured = [];
      for (const node of nodes) {
        const quads = await chrome.debugger.sendCommand({ tabId: tab.tabId }, 'DOM.getContentQuads', {
          backendNodeId: node.backendNodeId,
        });
        const model = await chrome.debugger.sendCommand({ tabId: tab.tabId }, 'DOM.getBoxModel', {
          backendNodeId: node.backendNodeId,
        });
        measured.push({
          backendNodeId: node.backendNodeId,
          attributes: node.attributes,
          rawQuads: quads,
          rawModel: model,
        });
      }
      const mainRect =
        'Object.assign({}, ...["x","y","width","height"].map(k => ({[k]:document.getElementById("increment").getBoundingClientRect()[k]})))';
      const before = await evaluate(
        tab.tabId,
        undefined,
        `({dpr:devicePixelRatio,innerWidth,innerHeight,increment:${mainRect},iframe:(()=>{const f=document.querySelector("iframe"),a=f.getBoundingClientRect(),b=f.contentDocument.getElementById("inner").getBoundingClientRect();return {owner:{x:a.x,y:a.y,width:a.width,height:a.height},inner:{x:b.x,y:b.y,width:b.width,height:b.height},client:{left:f.clientLeft,top:f.clientTop}}})()})`,
      );
      await evaluate(
        tab.tabId,
        undefined,
        'window.zoomMoves=[];document.addEventListener("mousemove",e=>window.zoomMoves.push({x:e.clientX,y:e.clientY,target:e.target.id,trusted:e.isTrusted}),true)',
      );
      for (const point of [
        { x: 100, y: 100 },
        { x: 200, y: 250 },
      ])
        await attachment.cdp.send(undefined, 'Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 0, ...point });
      const hits = [];
      for (const point of [
        { x: 100, y: 100 },
        { x: 200, y: 250 },
      ])
        hits.push({
          point,
          raw: await chrome.debugger.sendCommand({ tabId: tab.tabId }, 'DOM.getNodeForLocation', point),
          port: await attachment.cdp.send(undefined, 'DOM.getNodeForLocation', point),
        });
      const metrics = await attachment.cdp.send<{ cssContentSize: { width: number; height: number } }>(
        undefined,
        'Page.getLayoutMetrics',
      );
      const rawMetrics = await chrome.debugger.sendCommand({ tabId: tab.tabId }, 'Page.getLayoutMetrics');
      const prepared: Record<string, unknown> = {};
      try {
        await attachment.cdp.send(undefined, 'Emulation.setDeviceMetricsOverride', {
          mobile: false,
          width: Math.ceil(Math.max((before as { innerWidth: number }).innerWidth, metrics.cssContentSize.width)),
          height: Math.ceil(metrics.cssContentSize.height),
          deviceScaleFactor: 0,
        });
        prepared.viewport = await evaluate(
          tab.tabId,
          undefined,
          '({innerWidth,innerHeight,dpr:devicePixelRatio,bottom:{y:document.getElementById("bottom").getBoundingClientRect().y,height:document.getElementById("bottom").getBoundingClientRect().height}})',
        );
        prepared.rawMetrics = await chrome.debugger.sendCommand({ tabId: tab.tabId }, 'Page.getLayoutMetrics');
        const after = await attachment.cdp.send<{ cssContentSize: { width: number; height: number } }>(
          undefined,
          'Page.getLayoutMetrics',
        );
        for (const clipScale of [1, Number(args.zoom ?? 1.25)]) {
          const shot = await attachment.cdp.send<{ data: string }>(undefined, 'Page.captureScreenshot', {
            format: 'png',
            clip: {
              x: 0,
              y: 0,
              width: after.cssContentSize.width * clipScale,
              height: after.cssContentSize.height * clipScale,
              scale: 1,
            },
          });
          const bitmap = await createImageBitmap(
            new Blob([Uint8Array.from(atob(shot.data), c => c.charCodeAt(0))], { type: 'image/png' }),
          );
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
            context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0);
          const pixels = context.getImageData(Math.floor(bitmap.width / 2), 0, 1, bitmap.height).data;
          const red = [];
          for (let y = 0; y < bitmap.height; y++)
            if (pixels[y * 4] > 180 && pixels[y * 4 + 1] < 50 && pixels[y * 4 + 2] < 50) red.push(y);
          prepared[`clip-${clipScale}`] = {
            width: bitmap.width,
            height: bitmap.height,
            red: red.length ? [red[0], red[red.length - 1]] : [],
          };
          bitmap.close();
        }
      } finally {
        await attachment.cdp.send(undefined, 'Emulation.clearDeviceMetricsOverride');
      }
      return {
        browser: navigator.userAgent,
        zoom: await chrome.tabs.getZoom(tab.tabId),
        before,
        measured,
        hits,
        moves: await evaluate(tab.tabId, undefined, 'window.zoomMoves'),
        rawMetrics,
        metrics,
        prepared,
      };
    });
  },
});

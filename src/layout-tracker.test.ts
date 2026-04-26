import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutTracker } from './layout-tracker.js';

describe('LayoutTracker', () => {
  let tracker: LayoutTracker;
  const WS = 'ws-1';

  beforeEach(() => {
    tracker = new LayoutTracker();
  });

  it('initializes workspace with a single surface', () => {
    tracker.initWorkspace(WS, 's-1');
    expect(tracker.getSurfaces(WS)).toEqual(['s-1']);
  });

  it('first split of a wide pane goes right', () => {
    tracker.initWorkspace(WS, 's-1');
    // Root is 1.0 x 1.0 (square) → width >= height → right
    const { surfaceId, direction } = tracker.computeSplit(WS);
    expect(surfaceId).toBe('s-1');
    expect(direction).toBe('right');
  });

  describe('2 agents: [A][B]', () => {
    beforeEach(() => {
      tracker.initWorkspace(WS, 's-1');
      tracker.recordSplit(WS, 's-1', 's-2', 'right');
    });

    it('has two surfaces', () => {
      expect(tracker.getSurfaces(WS)).toEqual(['s-1', 's-2']);
    });

    it('next split goes down (panes are now tall)', () => {
      // After horizontal split: each pane is 0.5 x 1.0 (taller than wide)
      const { direction } = tracker.computeSplit(WS);
      expect(direction).toBe('down');
    });
  });

  describe('3 agents: [A][B] / splits → one pane split down', () => {
    beforeEach(() => {
      tracker.initWorkspace(WS, 's-1');
      tracker.recordSplit(WS, 's-1', 's-2', 'right');
      // Both s-1 and s-2 are 0.5x1.0 — either can be picked, both are tall
      const { surfaceId, direction } = tracker.computeSplit(WS);
      expect(direction).toBe('down');
      tracker.recordSplit(WS, surfaceId, 's-3', direction);
    });

    it('has three surfaces', () => {
      expect(tracker.getSurfaces(WS).sort()).toEqual(['s-1', 's-2', 's-3'].sort());
    });

    it('next split targets the larger unsplit pane', () => {
      // After splitting one of the tall panes down:
      // - Split pane: two 0.5x0.5 children
      // - Unsplit pane: 0.5x1.0 (larger area = 0.5 vs 0.25)
      const { direction } = tracker.computeSplit(WS);
      // The largest pane (0.5x1.0) is tall → split down
      expect(direction).toBe('down');
    });
  });

  describe('4 agents: 2x2 grid', () => {
    beforeEach(() => {
      tracker.initWorkspace(WS, 's-1');
      // Split 1: [s-1][s-2] — both 0.5x1.0
      tracker.recordSplit(WS, 's-1', 's-2', 'right');
      // Split 2: s-1 (0.5x1.0, tall) → down → s-1(0.5x0.5) + s-3(0.5x0.5)
      tracker.recordSplit(WS, 's-1', 's-3', 'down');
      // Split 3: s-2 (0.5x1.0, tall, largest) → down → s-2(0.5x0.5) + s-4(0.5x0.5)
      tracker.recordSplit(WS, 's-2', 's-4', 'down');
    });

    it('has four surfaces', () => {
      expect(tracker.getSurfaces(WS).sort()).toEqual(['s-1', 's-2', 's-3', 's-4'].sort());
    });

    it('all panes are equal size (0.5x0.5)', () => {
      // Next split: all panes are 0.5x0.5 (square) → direction should be right (width >= height)
      const { direction } = tracker.computeSplit(WS);
      expect(direction).toBe('right');
    });
  });

  describe('removeSurface', () => {
    it('removes a leaf and collapses the parent', () => {
      tracker.initWorkspace(WS, 's-1');
      tracker.recordSplit(WS, 's-1', 's-2', 'right');
      expect(tracker.getSurfaces(WS)).toEqual(['s-1', 's-2']);

      tracker.removeSurface(WS, 's-2');
      expect(tracker.getSurfaces(WS)).toEqual(['s-1']);

      // After removal, remaining pane should inherit full dimensions
      const { surfaceId, direction } = tracker.computeSplit(WS);
      expect(surfaceId).toBe('s-1');
      expect(direction).toBe('right'); // 1.0x1.0 → square → right
    });

    it('handles removal in a 2x2 grid', () => {
      tracker.initWorkspace(WS, 's-1');
      tracker.recordSplit(WS, 's-1', 's-2', 'right');
      tracker.recordSplit(WS, 's-1', 's-3', 'down');
      tracker.recordSplit(WS, 's-2', 's-4', 'down');

      // Remove one corner: s-3
      tracker.removeSurface(WS, 's-3');
      const surfaces = tracker.getSurfaces(WS).sort();
      expect(surfaces).toEqual(['s-1', 's-2', 's-4'].sort());

      // s-1 is now 0.5x1.0 (collapsed from parent), s-2 and s-4 are 0.5x0.5
      // Largest is s-1 → tall → should split down
      const { surfaceId, direction } = tracker.computeSplit(WS);
      expect(surfaceId).toBe('s-1');
      expect(direction).toBe('down');
    });
  });

  describe('removeWorkspace', () => {
    it('cleans up all tracking', () => {
      tracker.initWorkspace(WS, 's-1');
      tracker.recordSplit(WS, 's-1', 's-2', 'right');
      tracker.removeWorkspace(WS);
      expect(tracker.getSurfaces(WS)).toEqual([]);
      expect(() => tracker.computeSplit(WS)).toThrow();
    });
  });

  describe('computeSplit throws on unknown workspace', () => {
    it('throws', () => {
      expect(() => tracker.computeSplit('unknown')).toThrow(/No layout tracked/);
    });
  });
});

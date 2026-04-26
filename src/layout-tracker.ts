/**
 * Tracks logical pane layout within a workspace to determine optimal split
 * direction and target. Since cmux doesn't expose surface dimensions, we
 * maintain a virtual layout tree that mirrors split operations.
 *
 * Layout rules for readability:
 * 1. Always split the largest pane (most area) → even distribution
 * 2. Direction is determined by aspect ratio of the target pane:
 *    - wider than tall → split 'right' (vertical divider)
 *    - taller than wide → split 'down' (horizontal divider)
 * 3. This naturally produces grid-like layouts:
 *    1 agent:  [A]
 *    2 agents: [A][B]           (split right)
 *    3 agents: [A][B] / [C]    (split B down, or A down depending on ratio)
 *    4 agents: [A][B] / [C][D] (2x2 grid)
 */

export interface LayoutNode {
  id: string;                          // surface ID for leaves, internal ID for splits
  type: 'leaf' | 'split';
  direction?: 'horizontal' | 'vertical'; // horizontal = side-by-side, vertical = stacked
  children?: LayoutNode[];
  surfaceId?: string;                  // only for leaf nodes
  // Virtual dimensions (fractional, root = 1.0 x 1.0)
  width: number;
  height: number;
}

export class LayoutTracker {
  private roots = new Map<string, LayoutNode>(); // workspaceId → layout tree
  private nextInternalId = 0;

  /**
   * Initialize a workspace with its first surface.
   */
  initWorkspace(workspaceId: string, surfaceId: string): void {
    this.roots.set(workspaceId, {
      id: surfaceId,
      type: 'leaf',
      surfaceId,
      width: 1.0,
      height: 1.0,
    });
  }

  /**
   * Determine the best surface to split and direction for a new pane.
   * Returns { surfaceId, direction } for the optimal split.
   */
  computeSplit(workspaceId: string): { surfaceId: string; direction: 'right' | 'down' } {
    const root = this.roots.get(workspaceId);
    if (!root) {
      throw new Error(`No layout tracked for workspace ${workspaceId}`);
    }

    // Find the leaf with the largest area
    const largest = this.findLargestLeaf(root);
    if (!largest || !largest.surfaceId) {
      throw new Error(`No leaf found in layout for workspace ${workspaceId}`);
    }

    // Determine direction based on aspect ratio
    const direction = largest.width >= largest.height ? 'right' : 'down';

    return { surfaceId: largest.surfaceId, direction };
  }

  /**
   * Record a split that occurred. Updates the layout tree.
   */
  recordSplit(
    workspaceId: string,
    splitFromSurfaceId: string,
    newSurfaceId: string,
    direction: 'right' | 'down',
  ): void {
    const root = this.roots.get(workspaceId);
    if (!root) return;

    const replaced = this.replaceSurface(root, splitFromSurfaceId, (leaf) => {
      const splitDir = direction === 'right' ? 'horizontal' : 'vertical';
      const childWidth = direction === 'right' ? leaf.width / 2 : leaf.width;
      const childHeight = direction === 'down' ? leaf.height / 2 : leaf.height;

      const splitNode: LayoutNode = {
        id: `_split_${this.nextInternalId++}`,
        type: 'split',
        direction: splitDir,
        width: leaf.width,
        height: leaf.height,
        children: [
          {
            id: splitFromSurfaceId,
            type: 'leaf',
            surfaceId: splitFromSurfaceId,
            width: childWidth,
            height: childHeight,
          },
          {
            id: newSurfaceId,
            type: 'leaf',
            surfaceId: newSurfaceId,
            width: childWidth,
            height: childHeight,
          },
        ],
      };

      return splitNode;
    });

    if (replaced) {
      this.roots.set(workspaceId, replaced);
    }
  }

  /**
   * Remove a surface from the layout (when a pane is closed).
   */
  removeSurface(workspaceId: string, surfaceId: string): void {
    const root = this.roots.get(workspaceId);
    if (!root) return;

    const result = this.removeLeaf(root, surfaceId);
    if (result === null) {
      // Entire tree removed
      this.roots.delete(workspaceId);
    } else {
      this.roots.set(workspaceId, result);
    }
  }

  /**
   * Remove all tracking for a workspace.
   */
  removeWorkspace(workspaceId: string): void {
    this.roots.delete(workspaceId);
  }

  /**
   * Get all tracked leaf surface IDs in a workspace.
   */
  getSurfaces(workspaceId: string): string[] {
    const root = this.roots.get(workspaceId);
    if (!root) return [];
    return this.collectLeaves(root).map(l => l.surfaceId!);
  }

  /**
   * Get the layout tree for debugging/inspection.
   */
  getTree(workspaceId: string): LayoutNode | undefined {
    return this.roots.get(workspaceId);
  }

  // ── Internal helpers ──

  private findLargestLeaf(node: LayoutNode): LayoutNode | null {
    if (node.type === 'leaf') return node;

    let largest: LayoutNode | null = null;
    let maxArea = -1;

    for (const child of node.children ?? []) {
      const leaf = this.findLargestLeaf(child);
      if (leaf) {
        const area = leaf.width * leaf.height;
        if (area > maxArea) {
          maxArea = area;
          largest = leaf;
        }
      }
    }

    return largest;
  }

  private collectLeaves(node: LayoutNode): LayoutNode[] {
    if (node.type === 'leaf') return [node];
    const result: LayoutNode[] = [];
    for (const child of node.children ?? []) {
      result.push(...this.collectLeaves(child));
    }
    return result;
  }

  private replaceSurface(
    node: LayoutNode,
    surfaceId: string,
    replacer: (leaf: LayoutNode) => LayoutNode,
  ): LayoutNode | null {
    if (node.type === 'leaf') {
      if (node.surfaceId === surfaceId) {
        return replacer(node);
      }
      return node;
    }

    // Split node — recurse into children
    const newChildren: LayoutNode[] = [];
    let changed = false;
    for (const child of node.children ?? []) {
      const result = this.replaceSurface(child, surfaceId, replacer);
      if (result !== child) changed = true;
      if (result) newChildren.push(result);
    }

    if (!changed) return node;

    return { ...node, children: newChildren };
  }

  private removeLeaf(node: LayoutNode, surfaceId: string): LayoutNode | null {
    if (node.type === 'leaf') {
      return node.surfaceId === surfaceId ? null : node;
    }

    const remaining: LayoutNode[] = [];
    for (const child of node.children ?? []) {
      const result = this.removeLeaf(child, surfaceId);
      if (result) remaining.push(result);
    }

    if (remaining.length === 0) return null;
    if (remaining.length === 1) {
      // Collapse: promote the single remaining child, inheriting parent dimensions
      const promoted = { ...remaining[0], width: node.width, height: node.height };
      return promoted;
    }

    return { ...node, children: remaining };
  }
}

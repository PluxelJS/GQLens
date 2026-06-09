interface SieveNode<K, V> {
  readonly key: K;
  value: V;
  visited: boolean;
  previous: SieveNode<K, V> | null;
  next: SieveNode<K, V> | null;
}

export class SieveCache<K, V> {
  readonly #capacity: number;
  readonly #nodes = new Map<K, SieveNode<K, V>>();
  #head: SieveNode<K, V> | null = null;
  #tail: SieveNode<K, V> | null = null;
  #hand: SieveNode<K, V> | null = null;

  constructor(capacity: number) {
    this.#capacity = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
  }

  get(key: K): V | undefined {
    const node = this.#nodes.get(key);
    if (!node) {
      return undefined;
    }
    node.visited = true;
    return node.value;
  }

  set(key: K, value: V): void {
    const existing = this.#nodes.get(key);
    if (existing) {
      existing.value = value;
      existing.visited = true;
      return;
    }
    if (this.#capacity === 0) {
      return;
    }
    if (this.#nodes.size >= this.#capacity) {
      this.#evict();
    }

    const node: SieveNode<K, V> = {
      key,
      value,
      visited: false,
      previous: null,
      next: null,
    };
    this.#insertHead(node);
    this.#nodes.set(key, node);
    this.#hand ??= node;
  }

  #evict(): void {
    let candidate = this.#hand ?? this.#tail;
    while (candidate) {
      if (candidate.visited) {
        candidate.visited = false;
        candidate = this.#advance(candidate);
        this.#hand = candidate;
        continue;
      }

      const nextHand = this.#advance(candidate);
      this.#remove(candidate);
      this.#nodes.delete(candidate.key);
      this.#hand = this.#nodes.size === 0 || nextHand === candidate ? null : nextHand;
      return;
    }
  }

  #advance(node: SieveNode<K, V>): SieveNode<K, V> {
    return node.previous ?? this.#tail ?? node;
  }

  #insertHead(node: SieveNode<K, V>): void {
    node.next = this.#head;
    if (this.#head) {
      this.#head.previous = node;
    } else {
      this.#tail = node;
    }
    this.#head = node;
  }

  #remove(node: SieveNode<K, V>): void {
    if (node.previous) {
      node.previous.next = node.next;
    } else {
      this.#head = node.next;
    }
    if (node.next) {
      node.next.previous = node.previous;
    } else {
      this.#tail = node.previous;
    }
    node.previous = null;
    node.next = null;
  }
}

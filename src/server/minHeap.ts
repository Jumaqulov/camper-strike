/**
 * Minimal binary min-heap (tugun indeksi + f-score) — NavGraph va botLocalPath A* uchun umumiy.
 * `push(node, score)` / `pop()` eng kichik score'li tugunni qaytaradi; `size` — elementlar soni.
 */
export class MinHeap {
  private f: number[] = [];
  private n: number[] = [];
  get size(): number {
    return this.n.length;
  }
  push(node: number, score: number): void {
    this.f.push(score);
    this.n.push(node);
    let i = this.n.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p]! <= this.f[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.n[0]!;
    const lastF = this.f.pop()!;
    const lastN = this.n.pop()!;
    if (this.n.length > 0) {
      this.f[0] = lastF;
      this.n[0] = lastN;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n.length && this.f[l]! < this.f[m]!) m = l;
        if (r < this.n.length && this.f[r]! < this.f[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const tf = this.f[a]!;
    this.f[a] = this.f[b]!;
    this.f[b] = tf;
    const tn = this.n[a]!;
    this.n[a] = this.n[b]!;
    this.n[b] = tn;
  }
}

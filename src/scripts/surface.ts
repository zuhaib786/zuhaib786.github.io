/** Orthographic projection of a torus, shared by static rendering and interaction. */
export function surfaceLines(degrees: number): string[] {
  const angle = degrees * Math.PI / 180;
  const project = (u: number, v: number) => {
    const x = (2 + 0.78 * Math.cos(v)) * Math.cos(u);
    const y = (2 + 0.78 * Math.cos(v)) * Math.sin(u);
    const z = 0.78 * Math.sin(v);
    const a = x * Math.cos(angle) - z * Math.sin(angle);
    const b = x * Math.sin(angle) + z * Math.cos(angle);
    return `${(280 + a * 83).toFixed(2)},${(245 + (y * 0.48 - b * 0.88) * 83).toFixed(2)}`;
  };
  return [
    ...Array.from({ length: 64 }, (_, i) => Array.from({ length: 97 }, (_, j) => project(i / 64 * Math.PI * 2, j / 96 * Math.PI * 2)).join(" ")),
    ...Array.from({ length: 20 }, (_, i) => Array.from({ length: 161 }, (_, j) => project(j / 160 * Math.PI * 2, i / 20 * Math.PI * 2)).join(" ")),
  ];
}

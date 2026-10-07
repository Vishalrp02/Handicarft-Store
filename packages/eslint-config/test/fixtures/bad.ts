export function leak(value: any): number {
  console.log(value)
  const list = [1, 2, 3]
  return list[0]!
}

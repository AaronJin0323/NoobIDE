export function prepareDelivery(
  input: string,
  output: string,
  tag: string,
  sha: string,
): Promise<{ assets: string[]; notes: string }>;
export function deliveryArgs(tag: string, assets: string[], notes: string): string[];

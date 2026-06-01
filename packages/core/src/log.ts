export function stringifyLogJson(
  value: unknown,
  space?: string | number
): string {
  return escapeNonAscii(JSON.stringify(value, null, space) ?? "undefined");
}

export function escapeLogText(value: string): string {
  return escapeNonAscii(value);
}

function escapeNonAscii(value: string): string {
  return value.replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

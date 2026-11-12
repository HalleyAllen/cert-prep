const headingWithComma = /^([ \t　]*[1-9]\d?[ \t　]*)[,，](?=[ \t　]*\p{Script=Han}[^。\r\n！？；，、：.!?;,:]{0,31}[ \t　]*$)/u;

export function normalizeNumberedHeading(line) {
  return line.replace(headingWithComma, '$1.');
}

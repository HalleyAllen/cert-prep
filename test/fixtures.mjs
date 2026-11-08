import { crc32 } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';

export function imageFixture(format = 'image/png') {
  const canvas = createCanvas(1050, 480);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111'; ctx.font = '50px Microsoft YaHei, SimHei, Arial';
  ctx.fillText('项目管理 复习资料', 55, 110);
  ctx.font = '44px Arial';
  ctx.fillText('PROJECT STUDY GUIDE', 55, 205);
  ctx.fillText('Project scope and schedule', 55, 290);
  return canvas.toBuffer(format);
}

export function pdfFixture(scanned = false) {
  const stream = (body, extra = '') => Buffer.concat([
    Buffer.from(`<< /Length ${body.length} ${extra} >>\nstream\n`), body, Buffer.from('\nendstream'),
  ]);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 630 340] /Resources << ${scanned ? '/XObject << /Im0 5 0 R >>' : '/Font << /F1 5 0 R >>'} >> /Contents 4 0 R >>`,
    stream(Buffer.from(scanned ? 'q 610 0 0 279 10 30 cm /Im0 Do Q' : 'BT /F1 22 Tf 45 265 Td (Chapter 1 Project Scope) Tj 0 -35 Td (Scope defines the boundaries of a project.) Tj ET')),
    scanned ? stream(imageFixture('image/jpeg'), '/Type /XObject /Subtype /Image /Width 1050 /Height 480 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode')
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let position = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    chunks.push(bytes);
    position += bytes.length;
  });
  chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

export function docxFixture() {
  const entries = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一章 质量管理</w:t></w:r></w:p><w:p><w:r><w:t>验收依据是约定的标准与证据。</w:t></w:r></w:p></w:body></w:document>',
  };
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [path, contents] of Object.entries(entries)) {
    const filename = Buffer.from(path);
    const value = Buffer.from(contents);
    const checksum = crc32(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(value.length, 18); local.writeUInt32LE(value.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(value.length, 20); central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, value); directory.push(central, filename);
    offset += local.length + filename.length + value.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

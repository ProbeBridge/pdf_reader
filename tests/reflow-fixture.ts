import { deflateSync } from "node:zlib";

function pdfString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}
function image(width: number, height: number, mask = 0): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      pixels[i] = (x * 3 + y) % 256;
      pixels[i + 1] = (x + y * 3) % 256;
      pixels[i + 2] = 150;
    }
  const bytes = deflateSync(pixels);
  return Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${mask ? `/SMask ${mask} 0 R ` : ""}/Filter /FlateDecode /Length ${bytes.length} >>\nstream\n`,
    ),
    bytes,
    Buffer.from("\nendstream"),
  ]);
}
function grayImage(
  width: number,
  height: number,
  pixels: Buffer,
  mask = 0,
): Buffer {
  const bytes = deflateSync(pixels);
  return Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 ${mask ? `/SMask ${mask} 0 R ` : ""}/Filter /FlateDecode /Length ${bytes.length} >>\nstream\n`,
    ),
    bytes,
    Buffer.from("\nendstream"),
  ]);
}
function text(value: string, x: number, y: number, size = 14): string {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${pdfString(value)}) Tj ET\n`;
}
function grid(
  columns: number,
  rows: string[][],
  x: number,
  top: number,
  width: number,
  rowHeight: number,
  font: number,
): string {
  let out = "0 G 0.6 w\n";
  const bottom = top - rows.length * rowHeight;
  for (let c = 0; c <= columns; c++)
    out += `${x + (c * width) / columns} ${bottom} m ${x + (c * width) / columns} ${top} l S\n`;
  for (let r = 0; r <= rows.length; r++)
    out += `${x} ${top - r * rowHeight} m ${x + width} ${top - r * rowHeight} l S\n`;
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < columns; c++)
      out += text(
        rows[r][c] || "",
        x + (c * width) / columns + 3,
        top - (r + 1) * rowHeight + (rowHeight - font) / 2,
        font,
      );
  return out;
}

/** An actual PDF: no fixture HTML or mocked reflow output. MuPDF must discover
 * the untagged ruled grid and export its image and semantic table itself. */
export function makeReflowFixture(variant = "primary"): Buffer {
  const first =
    text(`Reflow ${variant} document`, 54, 750, 24) +
    text("The cooperation between components determines", 54, 710, 10.5) +
    text(
      "reliable behavior. A narrow reading pane should wrap this paragraph",
      54,
      694,
      10.5,
    ) +
    text("into additional lines.", 54, 678, 10.5) +
    text(
      "Pictures and register tables remain entirely inside the reading width.",
      54,
      656,
      10.5,
    ) +
    text("- FeatureFirst has no terminal punctuation", 54, 638, 10.5) +
    text("- FeatureSecond remains an independent item", 54, 622, 10.5) +
    grid(
      3,
      [
        ["Parameter", "Value", "Description"],
        ["Voltage", "3.3 V", "Supply"],
        ["Current", "12 mA", "Operating"],
        ["Clock", "48 MHz", "Main clock"],
      ],
      54,
      610,
      504,
      42,
      13,
    ) +
    "q 504 0 0 252 54 90 cm /Picture Do Q\n";
  const second =
    text("Register map", 54, 750, 24) +
    text(
      "All thirty-two register columns must remain visible without clipping.",
      54,
      710,
    ) +
    grid(
      32,
      [
        Array.from({ length: 32 }, (_, i) => String(31 - i)),
        Array.from({ length: 32 }, (_, i) => String(i % 2)),
      ],
      54,
      650,
      504,
      24,
      7,
    ) +
    text(
      "The original page number and bookmark destination must stay synchronized.",
      54,
      550,
    ) +
    text("ColumnRightOne begins the right paragraph.", 330, 509, 10) +
    text("ColumnLeftOne begins the left paragraph.", 54, 515, 10) +
    text("ColumnRightTwo continues its argument.", 330, 491, 10) +
    text("ColumnLeftTwo continues its argument.", 54, 497, 10) +
    text("ColumnRightThree ends the right paragraph.", 330, 473, 10) +
    text("ColumnLeftThree ends the left paragraph.", 54, 479, 10) +
    "q 504 0 0 252 54 180 cm /Picture Do Q\n";
  const third =
    text("Pending extraction cleanup", 54, 750, 24) +
    text(
      "Closing this tab must release an in-flight reflow task safely.",
      54,
      710,
    ) +
    text("Vector Block Diagram", 54, 674, 18) +
    "q 0 G 0.8 w 0.6 0.8 1 rg 54 570 110 50 re B " +
    "0.84 0.89 0.75 rg 240 510 110 50 re B " +
    "1 0.9 0.6 rg 430 570 110 50 re B " +
    "0 0 0 RG 164 595 m 240 535 l S 350 535 m 430 595 l S Q\n" +
    text("VectorInput", 64, 590, 12) +
    text("VectorProcess", 248, 530, 12) +
    text("VectorOutput", 440, 590, 12) +
    "q 504 0 0 252 54 180 cm /Heavy Do Q\n";
  const stream = (content: string) =>
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
  const watermarkMask = Buffer.alloc(240 * 160);
  for (let y = 40; y < 120; y++)
    for (let x = 20; x < 220; x++)
      if (y < 46 || y >= 114 || x < 26 || x >= 214)
        watermarkMask[y * 240 + x] = 255;
  const watermark = "q 504 0 0 336 54 240 cm /Watermark Do Q\n";
  const objects: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>",
    "<< /Type /Pages /Kids [7 0 R 8 0 R 9 0 R] /Count 3 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    image(1800, 900, 18),
    image(3600, 1800),
    "<< /Type /Outlines /First 13 0 R /Last 15 0 R /Count 3 >>",
    ...[10, 11, 12].map(
      (content) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Picture 4 0 R /Heavy 5 0 R /Watermark 16 0 R >> >> /Contents ${content} 0 R >>`,
    ),
    stream(watermark + first),
    stream(watermark + second),
    stream(watermark + third),
    "<< /Title (Overview) /Parent 6 0 R /Next 14 0 R /Dest [7 0 R /XYZ null null 0] >>",
    "<< /Title (Register map) /Parent 6 0 R /Prev 13 0 R /Next 15 0 R /Dest [8 0 R /XYZ null null 0] >>",
    "<< /Title (Cleanup) /Parent 6 0 R /Prev 14 0 R /Dest [9 0 R /XYZ null null 0] >>",
    grayImage(240, 160, Buffer.alloc(240 * 160, 190), 17),
    grayImage(240, 160, watermarkMask),
    grayImage(1, 1, Buffer.from([255])),
  ];
  const chunks: Buffer[] = [
      Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1"),
    ],
    offsets = [0];
  let size = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(size);
    const object = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      typeof objects[i] === "string"
        ? Buffer.from(objects[i] as string)
        : (objects[i] as Buffer),
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(object);
    size += object.length;
  }
  chunks.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

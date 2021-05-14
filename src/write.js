/* global globalThis */
/**
 * Conflux
 * Build (and read) zip files with whatwg streams in the browser.
 *
 * @author Transcend Inc. <https://transcend.io>
 * @license MIT
 */
// eslint-disable-next-line import/extensions
import { TransformStream as PonyfillTransformStream } from 'web-streams-polyfill/ponyfill';
import JSBI from './bigint';
import Crc32 from './crc.js';

const zip64ExtraFieldLength = 28;
const centralHeaderSignature = 0x504b0102, CDLength = 46;
const eocdSignature = 0x504b0506, eocdMinLength = 22;
const zip64EOCDRSignature = 0x504b0606, zip64EOCDRLength = 56;
const zip64EOCDRLocatorSignature = 0x504b0607, zip64EOCDRLocatorLength = 20;

const zip64CDExtraField = {
  signature: 0,
  fieldSize: 2,
  uncompressedSize: 4,
  compressedSize: 12,
  lfhOffset: 20
}

const zip64EOCDR = {
  signature: 0,
  eocdrSize: 4,
  versionCreated: 12,
  versionRequired: 14,
  cdRecordsOnDisk: 24,
  cdTotalRecords: 32,
  cdSize: 40,
  cdOffset: 48
}

const CD = {
  signature: 0,
  versionCreated: 4,
  versionRequired: 6,
  flags: 8,
  mode: 10,
  time: 12,
  date: 14,
  crc: 16,
  uncompressedSize: 20,
  compressedSize: 24,
  filenameLength: 28,
  extraDataLength: 30,
  commentLength: 32,
  lfhOffset: 42,
  filename: 46
}

const zip64EOCDRLocator = {
  signature: 0,
  eocdOffset: 8,
  numOfDisks: 16
}


const encoder = new TextEncoder();

class ZipTransformer {
  constructor() {
    this.files = Object.create(null);
    this.filenames = [];
    this.offset = JSBI.BigInt(0);
  }

  getZip64ExtraField(uncompressedSize, compressedSize, offset) {
    let extraField = new Uint8Array(zip64ExtraFieldLength);
    let dv = new DataView(extraField.buffer);

    dv.setUint16(zip64CDExtraField.signature, 1, true);
    dv.setUint16(zip64CDExtraField.fieldSize, 24, true);
    dv.setBigUint64(zip64CDExtraField.uncompressedSize, BigInt(uncompressedSize), true);
    dv.setBigUint64(zip64CDExtraField.compressedSize, BigInt(compressedSize), true);
    dv.setBigUint64(zip64CDExtraField.lfhOffset, BigInt(offset), true);
    return extraField;
  }

  writeCD(ctrl, index, length) {
    const data = new Uint8Array(length + 22 + (zip64ExtraFieldLength * this.filenames.length));
    const dv = new DataView(data.buffer);
    let file;

    this.filenames.forEach((fileName) => {
      file = this.files[fileName];
      dv.setUint32(index + CD.signature, centralHeaderSignature);
      dv.setUint16(index + CD.versionCreated, 0x2d00);
      dv.setUint16(index + CD.commentLength, file.comment.length, true);
      dv.setUint8(index + 38, file.directory ? 16 : 0);
      dv.setUint32(index + CD.lfhOffset, 0xffffffff, true);
      data.set(file.header, index + 6);
      data.set(file.nameBuf, index + CDLength);
      dv.setUint16(index + CD.extraDataLength, 0x1c, true);
      let zip64Field = this.getZip64ExtraField(file.uncompressedLength, file.compressedLength, file.offset);
      data.set(zip64Field, index + CDLength + file.nameBuf.length)
      data.set(file.comment, index + CDLength + file.nameBuf.length + zip64Field.length);
      index += 46 + file.nameBuf.length + file.comment.length + zip64Field.length;
    });

    ctrl.enqueue(data);
    return index;
  }

  writeZip64EOCDLocator(ctrl, index, cdSize) {
    let zip64EOCDOffset = BigInt(this.offset) + BigInt(cdSize + eocdMinLength);

    let zip64eocdLocator = new Uint8Array(zip64EOCDRLocatorLength);
    let dv = new DataView(zip64eocdLocator.buffer);

    dv.setUint32(zip64EOCDRLocator.signature, zip64EOCDRLocatorSignature);
    dv.setBigUint64(zip64EOCDRLocator.eocdOffset, BigInt(zip64EOCDOffset), true);
    dv.setUint32(zip64EOCDRLocator.numOfDisks, 1, true);
    ctrl.enqueue(zip64eocdLocator);
    return index += zip64EOCDRLocatorLength;
  }

  writeZip64EOCD(ctrl, index, offset, filenames, cdSize) {
    let zip64eocd = new Uint8Array(zip64EOCDRLength);
    let dv = new DataView(zip64eocd.buffer);

    dv.setUint32(zip64EOCDR.signature, zip64EOCDRSignature);
    dv.setBigUint64(zip64EOCDR.eocdrSize, BigInt(zip64EOCDRLength - 12), true);
    dv.setUint16(zip64EOCDR.versionCreated, 0x2d00);
    dv.setUint16(zip64EOCDR.versionRequired, 0x2d00);
    dv.setBigUint64(zip64EOCDR.cdRecordsOnDisk, BigInt(filenames.length), true);
    dv.setBigUint64(zip64EOCDR.cdTotalRecords, BigInt(filenames.length), true);
    dv.setBigUint64(zip64EOCDR.cdSize, BigInt(cdSize + eocdMinLength), true);
    dv.setBigUint64(zip64EOCDR.cdOffset, BigInt(offset), true);

    ctrl.enqueue(zip64eocd);
    return index += zip64EOCDRLength;
  }

  writeEOCD(ctrl, index, filenames, offset, length, isZip64) {
    let zipEOCD = new Uint8Array(eocdMinLength);
    let dv = new DataView(zipEOCD.buffer);

    if (!isZip64) {
      dv.setUint32(0, eocdSignature);
      dv.setUint16(8, filenames.length, true);
      dv.setUint16(10, filenames.length, true);
      dv.setUint32(12, length, true);
      dv.setUint32(16, JSBI.toNumber(offset), true);
    } else {
      dv.setUint32(0, eocdSignature);
      dv.setUint16(8, 0xffff, true);
      dv.setUint16(10, 0xffff, true);
      dv.setUint32(12, 0xffffffff, true);
      dv.setUint32(16, 0xffffffff, true);
    }

    ctrl.enqueue(zipEOCD);
  }


  /**
   * [transform description]
   *
   * @param  {File}  entry [description]
   * @param  {ReadableStreamDefaultController}  ctrl
   * @return {Promise}       [description]
   */
  async transform(entry, ctrl) {
    let name = entry.name.trim();
    const date = new Date(
      typeof entry.lastModified === 'undefined'
        ? Date.now()
        : entry.lastModified,
    );

    if (entry.directory && !name.endsWith('/')) name += '/';
    if (this.files[name]) ctrl.abort(new Error('File already exists.'));

    const nameBuf = encoder.encode(name);
    this.filenames.push(name);

    this.files[name] = {
      directory: !!entry.directory,
      nameBuf,
      offset: this.offset,
      comment: encoder.encode(entry.comment || ''),
      compressedLength: JSBI.BigInt(0),
      uncompressedLength: JSBI.BigInt(0),
      header: new Uint8Array(26),
    };

    const zipObject = this.files[name];

    const { header } = zipObject;
    const hdv = new DataView(header.buffer);
    const data = new Uint8Array(30 + nameBuf.length);

    hdv.setUint32(0, 0x2d000808);
    hdv.setUint16(
      6,
      (((date.getHours() << 6) | date.getMinutes()) << 5) |
        (date.getSeconds() / 2),
      true,
    );
    hdv.setUint16(
      8,
      ((((date.getFullYear() - 1980) << 4) | (date.getMonth() + 1)) << 5) |
        date.getDate(),
      true,
    );
    hdv.setUint16(22, nameBuf.length, true);
    data.set([80, 75, 3, 4]);
    data.set(header, 4);
    data.set(nameBuf, 30);

    this.offset = JSBI.add(this.offset, JSBI.BigInt(data.length));
    ctrl.enqueue(data);

    const footer = new Uint8Array(16);
    footer.set([80, 75, 7, 8]);

    if (entry.stream) {
      zipObject.crc = new Crc32();
      const reader = entry.stream().getReader();

      while (true) {
        const it = await reader.read();
        if (it.done) break;
        const chunk = it.value;
        zipObject.crc.append(chunk);
        zipObject.uncompressedLength = JSBI.add(
          zipObject.uncompressedLength,
          JSBI.BigInt(chunk.length),
        );
        zipObject.compressedLength = JSBI.add(
          zipObject.compressedLength,
          JSBI.BigInt(chunk.length),
        );
        ctrl.enqueue(chunk);
      }

      hdv.setUint32(10, zipObject.crc.get(), true);
      hdv.setUint32(14, 0xffffffff, true);
      hdv.setUint32(18, 0xffffffff, true);
      footer.set(header.subarray(10, 22), 4);
    }

    hdv.setUint16(22, nameBuf.length, true);

    this.offset = JSBI.add(
      this.offset,
      JSBI.add(zipObject.compressedLength, JSBI.BigInt(16)),
    );

    ctrl.enqueue(footer);
  }

  /**
   * @param  {ReadableStreamDefaultController} ctrl
   */
  flush(ctrl) {
    let length = 0;
    let index = 0;
    let file;

    this.filenames.forEach((fileName) => {
      file = this.files[fileName];
      length += 46 + file.nameBuf.length + file.comment.length;
    });

    index = this.writeCD(ctrl, index, length)
    const cdSize = index;
    index = this.writeZip64EOCD(ctrl, index, this.offset, this.filenames, cdSize);
    index = this.writeZip64EOCDLocator(ctrl, index, cdSize);
    this.writeEOCD(ctrl, index, this.filenames, this.offset, length, true);

    // cleanup
    this.files = Object.create(null);
    this.filenames = [];
    this.offset = 0;
  }
}

const ts =
  globalThis.TransformStream ||
  globalThis.WebStreamsPolyfill?.TransformStream ||
  PonyfillTransformStream;

class Writer extends ts {
  constructor() {
    super(new ZipTransformer());
  }
}

export default Writer;

import { SaxesParser } from 'saxes';
import { failure } from './mutations.ts';

const allowedTags = new Set('title p h1 h2 h3 h4 h5 h6 h7 h8 h9 b em u del br span blockquote hr pre code ol ul li checkbox table thead tbody tr th td colgroup col latex a img source figure grid column callout'.split(' '));
const passiveAttributes = new Set('id align seq lang caption name width height background-color border-color text-color vertical-align colspan rowspan span done view-type width-ratio emoji'.split(' '));
export function validateDocumentXml(content: string) {
  if (Buffer.byteLength(content) > 100000 || content.startsWith('@') || content === '-') throw failure('document_xml_too_large_or_not_inline');
  const parser = new SaxesParser({ fragment: true });
  parser.on('doctype', () => { throw failure('document_external_resources_not_supported'); });
  parser.on('processinginstruction', () => { throw failure('document_external_resources_not_supported'); });
  parser.on('opentag', node => {
    if (!allowedTags.has(node.name)) throw failure('document_xml_tag_not_supported_use_catalog_guide');
    for (const [name, value] of Object.entries(node.attributes)) {
      if (passiveAttributes.has(name)) continue;
      if (node.name === 'a' && name === 'href') {
        let url; try { url = new URL(value); } catch { throw failure('invalid_document_link'); }
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw failure('invalid_document_link');
        continue; // Text links are not downloaded by the CLI.
      }
      if ((node.name === 'img' && name === 'src') || (node.name === 'source' && name === 'token')) {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw failure('invalid_document_media_token');
        continue;
      }
      throw failure('document_external_resources_not_supported');
    }
  });
  try { parser.write(content).close(); } catch (error) { throw failure(error.code || 'invalid_document_xml'); }
  return content;
}

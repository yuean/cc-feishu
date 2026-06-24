import assert from 'assert/strict';
import { resolve } from 'path';

const {
  appendFeishuAttachmentInstructions,
  hasFeishuAttachmentUploadProtocol,
  parseFeishuResponse,
} = require('../src/bot/response-attachments') as typeof import('../src/bot/response-attachments');

function main(): void {
  const cwd = 'C:\\work\\demo';
  const parsed = parseFeishuResponse(
    [
      '处理完成，结果如下。',
      '[[feishu_image:output\\\\chart.png]]',
      '[[feishu_file:`reports\\\\summary.pdf`]]',
    ].join('\n'),
    cwd,
  );

  assert.equal(parsed.text, '处理完成，结果如下。');
  assert.deepEqual(parsed.attachments, [
    {
      kind: 'image',
      originalPath: 'output\\\\chart.png',
      resolvedPath: resolve(cwd, 'output\\\\chart.png'),
    },
    {
      kind: 'file',
      originalPath: 'reports\\\\summary.pdf',
      resolvedPath: resolve(cwd, 'reports\\\\summary.pdf'),
    },
  ]);

  const instructed = appendFeishuAttachmentInstructions('请生成一个图表并回传。');
  assert.match(instructed, /\[\[feishu_image:relative-or-absolute-path\]\]/);
  assert.match(instructed, /\[\[feishu_file:relative-or-absolute-path\]\]/);
  assert.match(instructed, /Only mark final user-facing deliverables/);
  assert.match(instructed, /Do not mark source code files, scripts, patches, logs, temp files, or other intermediate artifacts unless the user explicitly asks for them\./);
  assert.equal(hasFeishuAttachmentUploadProtocol(instructed), true);
  assert.equal(appendFeishuAttachmentInstructions(instructed), instructed);
  assert.equal(hasFeishuAttachmentUploadProtocol('普通回复，不需要附件。'), false);

  const trailingOnly = parseFeishuResponse(
    [
      '这里的 marker 只是正文示例，不应该触发上传：',
      '[[feishu_image:docs\\\\example.png]]',
      '',
      '最终说明保留在正文里。',
      '',
      '[[feishu_file:reports\\\\summary.pdf]]',
    ].join('\n'),
    cwd,
  );

  assert.equal(
    trailingOnly.text,
    [
      '这里的 marker 只是正文示例，不应该触发上传：',
      '[[feishu_image:docs\\\\example.png]]',
      '',
      '最终说明保留在正文里。',
    ].join('\n'),
  );
  assert.deepEqual(trailingOnly.attachments, [
    {
      kind: 'file',
      originalPath: 'reports\\\\summary.pdf',
      resolvedPath: resolve(cwd, 'reports\\\\summary.pdf'),
    },
  ]);

  console.log('response-attachments.test.ts passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

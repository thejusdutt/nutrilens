/**
 * A `transport` for estimateNutrition that talks to Claude on AWS Bedrock by
 * shelling out to the AWS CLI. No SDK dependency, no key handling — it borrows
 * whatever SSO credentials the surrounding shell already has, which is how the
 * rest of this machine reaches Bedrock.
 *
 * Node-only. It is never bundled into the browser app; the build scripts import
 * it, the PWA does not.
 */
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_MODEL = 'eu.anthropic.claude-sonnet-5';
const DEFAULT_REGION = 'eu-central-1';

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; reject(err); return; }
        resolve(stdout);
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a Bedrock transport bound to a model + region.
 *
 * Extended thinking is ON by default and matters here: these Claude models
 * reason before answering, and for a per-100 g recipe calculation that internal
 * arithmetic is most of what makes the number right. The reasoning tokens are
 * discarded — only the final text block is returned — but the budget has to fit
 * inside maxTokens or the model spends the whole allowance thinking and emits
 * no answer (stopReason max_tokens with a lone reasoningContent block, which is
 * exactly how the first run of this failed). So maxTokens is generous and the
 * text block is picked out of the content array wherever it lands.
 *
 * @param {{model?:string, region?:string, timeoutMs?:number, maxRetries?:number,
 *   thinking?:boolean, effort?:'low'|'medium'|'high'}} [cfg]
 *   thinking:false turns reasoning off; effort tunes how hard it thinks (Claude 5
 *   uses adaptive thinking + output_config.effort, not a fixed token budget).
 * @returns {(req:{system:string,messages:{role:string,content:string}[],maxTokens:number,model?:string})=>Promise<string>}
 */
export function bedrockTransport(cfg = {}) {
  const region = cfg.region ?? DEFAULT_REGION;
  const model = cfg.model ?? DEFAULT_MODEL;
  const timeoutMs = cfg.timeoutMs ?? 120_000;
  const maxRetries = cfg.maxRetries ?? 4;
  const thinking = cfg.thinking !== false; // adaptive thinking on by default
  const effort = cfg.effort ?? null;

  return async function transport({ system, messages, maxTokens, model: modelOverride }) {
    const dir = mkdtempSync(join(tmpdir(), 'cn-'));
    const msgPath = join(dir, 'messages.json');
    const sysPath = join(dir, 'system.json');
    // Adaptive thinking spends output tokens before the answer, so the cap must
    // clear the thinking too or the reply is a lone reasoning block (stop=max_tokens).
    const cap = thinking ? Math.max(maxTokens ?? 700, 3000) : Math.max(maxTokens ?? 700, 500);
    writeFileSync(msgPath, JSON.stringify(messages.map((m) => ({
      role: m.role, content: [{ text: m.content }],
    }))));
    writeFileSync(sysPath, JSON.stringify(system ? [{ text: system }] : []));
    const args = [
      'bedrock-runtime', 'converse',
      '--region', region,
      '--model-id', modelOverride ?? model,
      '--messages', `file://${msgPath}`,
      '--inference-config', `maxTokens=${cap}`,
      '--output', 'json',
    ];
    if (system) args.splice(6, 0, '--system', `file://${sysPath}`);
    // Claude 5: reasoning is controlled by thinking.type=adaptive + output_config.effort.
    // "enabled"/token-budget is a Claude 4 shape this model rejects.
    const extra = {};
    if (!thinking) extra.thinking = { type: 'disabled' };
    else if (effort) { extra.thinking = { type: 'adaptive' }; extra.output_config = { effort }; }
    if (Object.keys(extra).length) {
      args.push('--additional-model-request-fields', JSON.stringify(extra));
    }
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await run('aws', args, timeoutMs);
          const parsed = JSON.parse(out);
          const blocks = parsed?.output?.message?.content ?? [];
          // Skip reasoningContent blocks; take the first real text block.
          const textBlock = blocks.find((b) => typeof b?.text === 'string');
          const text = textBlock?.text;
          if (typeof text !== 'string') {
            const kinds = blocks.map((b) => Object.keys(b)[0]).join(',') || 'none';
            throw new Error(`Bedrock reply had no text content (stop=${parsed?.stopReason}, blocks=${kinds})`);
          }
          return text;
        } catch (e) {
          const msg = `${e.message} ${e.stderr ?? ''}`;
          const throttled = /Throttl|TooManyRequests|ServiceUnavailable|timed out|ETIMEDOUT|429|503/i.test(msg);
          if (throttled && attempt < maxRetries) {
            await sleep(Math.min(15_000, 1000 * 2 ** attempt) + Math.random() * 500);
            continue;
          }
          throw new Error(`Bedrock call failed: ${msg.slice(0, 300)}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export { DEFAULT_MODEL, DEFAULT_REGION };

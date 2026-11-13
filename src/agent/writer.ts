/**
 * Turns the agent's findings into words. Without an API key it uses plain templates; with
 * ANTHROPIC_API_KEY it asks Claude to write from the same facts. Claude only rewrites facts it is
 * given; drafts are never sent without a person approving them.
 */

export interface Draft { subject: string; body: string; writtenBy: 'template' | 'claude' }

export class Writer {
  constructor(private apiKey = process.env.ANTHROPIC_API_KEY ?? '', private model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5') {}

  private async claude(system: string, facts: unknown, maxTokens = 700): Promise<string | null> {
    if (!this.apiKey) return null;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: `Facts (JSON):\n${JSON.stringify(facts, null, 2)}` }] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const json: any = await res.json();
      const text = (json.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
      return text || null;
    } catch {
      return null;
    }
  }

  async incidentMessage(i: { title: string; summary: string; cause: string; siteName: string | null; openedAt: Date; devices: string[]; status: string }, orgName: string): Promise<Draft> {
    const when = i.openedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const subject = `${i.status === 'resolved' ? 'Resolved' : 'Update'}: ${i.title}`;
    const next: Record<string, string> = {
      power_outage: 'Please check the generator or mains supply at the site. The devices keep recording on battery where fitted and will send their readings when power returns.',
      site_connectivity: 'Please check the site\'s internet router or GSM signal. The devices keep recording and will send everything they stored once they reconnect, so no readings should be lost.',
      gateway_down: 'Please check that the LoRa gateway has power and internet. The sensors keep recording and will catch up once the gateway is back.',
      site_condition: 'Please check the site for a common cause, such as ventilation, an open door or weather, and take action to bring readings back within limits.',
    };
    const template = [
      `Hello ${orgName} team,`,
      '',
      `Titan detected this at ${when}: ${i.title}.`,
      '',
      i.summary,
      '',
      i.status === 'resolved' ? 'This has now cleared. No action is needed.' : (next[i.cause] ?? 'Please take a look and let us know if you need help.'),
      '',
      `Devices involved: ${i.devices.join(', ') || 'n/a'}.`,
      '',
      'Reply to this email if you need help from the Kitovu team.',
      '',
      'Kitovu Titan support',
    ].join('\n');
    const written = await this.claude(
      'You write short, clear operational emails from Kitovu (an agritech company) to a customer about their monitored sites. Use only the facts given. Plain language, no jargon, no blame, no exaggeration, no promises not in the facts. Under 150 words. Start with "Hello <organisation> team," and end with "Kitovu Titan support". Return only the email body.',
      { organisation: orgName, ...i, openedAt: when, suggestedNextStep: next[i.cause] },
    );
    return written ? { subject, body: written, writtenBy: 'claude' } : { subject, body: template, writtenBy: 'template' };
  }

  async reportNarrative(data: any): Promise<{ text: string; writtenBy: 'template' | 'claude' }> {
    const lines: string[] = [];
    const sites = data.sites ?? [];
    const offlineWorst = [...sites].sort((a: any, b: any) => a.uptimePct - b.uptimePct)[0];
    lines.push(`In ${data.periodLabel}, Titan monitored ${sites.length} site${sites.length === 1 ? '' : 's'} and ${data.totals.devices} device${data.totals.devices === 1 ? '' : 's'} for ${data.org.name}, recording ${data.totals.readings.toLocaleString()} readings.`);
    lines.push(data.totals.alerts ? `${data.totals.alerts} alert${data.totals.alerts === 1 ? ' was' : 's were'} raised${data.totals.critical ? `, ${data.totals.critical} of them critical` : ''}.` : 'No alerts were raised.');
    if (data.incidents?.length) lines.push(`Titan grouped them into ${data.incidents.length} incident${data.incidents.length === 1 ? '' : 's'}, such as "${data.incidents[0].title}".`);
    if (offlineWorst && offlineWorst.uptimePct < 95) lines.push(`${offlineWorst.name} had the lowest reporting rate at ${offlineWorst.uptimePct}%; check its power and connection.`);
    if (data.carbon?.netTco2e) lines.push(`Carbon projects recorded ${data.carbon.netTco2e} tCO₂e across ${data.carbon.calculated} calculated batch${data.carbon.calculated === 1 ? '' : 'es'} or periods.`);
    const template = lines.join(' ');
    const written = await this.claude(
      'You write the summary paragraph of a monthly monitoring report from Kitovu to a customer. Use only the facts given; do not invent causes or numbers. Plain, warm, professional. 80–140 words. Mention anything that needs the customer\'s attention first. Return only the paragraph.',
      data, 400,
    );
    return written ? { text: written, writtenBy: 'claude' } : { text: template, writtenBy: 'template' };
  }
}

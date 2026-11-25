import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, MessageCircle, RefreshCw, Search, Send } from 'lucide-react';
import { apiRequest } from './api';
import type { Employee } from './data';

type WaSettings = { enabled: boolean; groupName: string; sendTime: string; departmentOrder: string[] };
type WaBot = { online: boolean; state: string; groupFound: boolean | null; lastSentDate: string | null; lastError: string | null; seenAt: string | null };
type WaResponse = {
  settings: WaSettings;
  hods: Record<string, { name: string; phone: string }>;
  phones: Record<string, string>;
  departments: string[];
  tokenConfigured: boolean;
  bot: WaBot;
};

const botLabel: Record<string, string> = {
  connected: 'Bot online · WhatsApp connected',
  'waiting-for-qr': 'Bot online · scan the QR code on the office PC',
  reconnecting: 'Bot online · reconnecting to WhatsApp',
  'logged-out': 'Bot logged out of WhatsApp · scan again on the office PC',
  starting: 'Bot starting',
  offline: 'Bot offline · start it on the office PC',
};

/** Shows a phone number like 98765 43210 (without the 91 country code) for editing. */
const displayPhone = (phone: string) => {
  const local = phone.startsWith('91') && phone.length === 12 ? phone.slice(2) : phone;
  return local.length === 10 ? `${local.slice(0, 5)} ${local.slice(5)}` : local;
};

export function WhatsAppSettings({ auth, employees }: { auth: string; employees: Employee[] }) {
  const [data, setData] = useState<WaResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<WaSettings>({ enabled: false, groupName: '', sendTime: '10:00', departmentOrder: [] });
  const [hodDrafts, setHodDrafts] = useState<Record<string, { name: string; phone: string }>>({});
  const [phoneDrafts, setPhoneDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [saving, setSaving] = useState('');
  const [query, setQuery] = useState('');
  const [orderChanged, setOrderChanged] = useState(false);

  const load = async () => {
    setLoadError('');
    try {
      const response = await apiRequest<WaResponse>('/api/whatsapp/settings', auth);
      setData(response);
      setForm({ ...response.settings, departmentOrder: response.settings.departmentOrder ?? [] });
      setOrderChanged(false);
      setHodDrafts(Object.fromEntries(response.departments.map((dept) => [dept, {
        name: response.hods[dept]?.name ?? '',
        phone: response.hods[dept]?.phone ? displayPhone(response.hods[dept].phone) : '',
      }])));
      setPhoneDrafts(Object.fromEntries(Object.entries(response.phones).map(([ticket, phone]) => [ticket, displayPhone(phone)])));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load WhatsApp settings.');
    }
  };
  useEffect(() => { void load(); }, [auth]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setSaving(key);
    setMessage(null);
    try {
      await action();
      setMessage({ text: success });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Save failed.', error: true });
    } finally {
      setSaving('');
    }
  };

  // Departments in message order: HR's saved order first, any others after it (Office first, then A–Z).
  const orderedDepartments = useMemo(() => {
    const all = data?.departments ?? [];
    const chosen = form.departmentOrder.filter((dept) => all.includes(dept));
    const isOffice = (dept: string) => dept.trim().toLowerCase() === 'office';
    const rest = all.filter((dept) => !chosen.includes(dept))
      .sort((a, b) => Number(isOffice(b)) - Number(isOffice(a)) || a.localeCompare(b));
    return [...chosen, ...rest];
  }, [data, form.departmentOrder]);
  const moveDepartment = (index: number, step: -1 | 1) => {
    const next = [...orderedDepartments];
    const target = index + step;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setForm({ ...form, departmentOrder: next });
    setOrderChanged(true);
  };

  const saveSettings = (key = 'settings', success = 'WhatsApp alert settings saved.') => run(key, async () => {
    await apiRequest('/api/whatsapp/settings', auth, { method: 'PUT', body: JSON.stringify({ ...form, departmentOrder: orderedDepartments }) });
    setOrderChanged(false);
  }, success);
  const sendAgain = () => run('resend', async () => {
    await apiRequest('/api/whatsapp/resend', auth, { method: 'POST', body: '{}' });
  }, 'Sending again. The bot posts it to the group within a minute.');
  const saveHod = (department: string) => run(`hod-${department}`, async () => {
    const saved = await apiRequest<{ name: string; phone: string }>('/api/whatsapp/hods', auth, { method: 'PUT', body: JSON.stringify({ department, ...hodDrafts[department] }) });
    setHodDrafts((current) => ({ ...current, [department]: { name: saved.name, phone: saved.phone ? displayPhone(saved.phone) : '' } }));
  }, `HOD saved for ${department}.`);
  const savePhone = (employee: Employee) => run(`phone-${employee.id}`, async () => {
    const saved = await apiRequest<{ phone: string }>(`/api/employees/${encodeURIComponent(employee.id)}/phone`, auth, { method: 'PUT', body: JSON.stringify({ phone: phoneDrafts[employee.id] ?? '' }) });
    setPhoneDrafts((current) => ({ ...current, [employee.id]: saved.phone ? displayPhone(saved.phone) : '' }));
    setData((current) => current && { ...current, phones: { ...current.phones, [employee.id]: saved.phone } });
  }, `Phone saved for ${employee.name}.`);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return employees
      .filter((employee) => !q || [employee.name, employee.id, employee.department].some((value) => value.toLowerCase().includes(q)))
      .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
  }, [employees, query]);

  const withPhone = data ? employees.filter((employee) => data.phones[employee.id]).length : 0;
  const bot = data?.bot;

  return <section className="panel workspace-panel wa-panel">
    <div className="workspace-panel-heading">
      <div className="wa-title"><div className="settings-card-icon"><MessageCircle size={18} /></div><div><h2>WhatsApp alerts</h2><p>Every day at the send time, the latest report’s present, absent, late arrivals, early departures and missing punches go to the WhatsApp group, department by department, tagging each department’s HOD and the employee.</p></div></div>
      <button className="button-tertiary" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button>
    </div>

    {loadError ? <p className="form-error">{loadError}</p> : !data ? <p className="form-hint">Loading WhatsApp settings…</p> : <>
      <div className={`wa-bot-status ${bot?.online && bot.state === 'connected' ? 'ok' : 'warn'}`}>
        <i />
        <div>
          <strong>{botLabel[bot?.state ?? 'offline'] ?? `Bot: ${bot?.state}`}</strong>
          <span>
            {bot?.lastSentDate ? `Last sent: report of ${new Date(`${bot.lastSentDate}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}` : 'Nothing sent yet'}
            {bot?.groupFound === false ? ' · group not found' : ''}
            {!data.tokenConfigured ? ' · WA_BOT_TOKEN is not set on the server' : ''}
          </span>
          {bot?.lastError && <span className="wa-bot-error">{bot.lastError}</span>}
        </div>
        {bot?.lastSentDate && <button className="button-secondary wa-resend" disabled={saving === 'resend' || !form.enabled} title={form.enabled ? 'Post the last report to the group again, with the current tags' : 'Turn on Send daily alerts first'} onClick={() => void sendAgain()}><Send size={14} /> {saving === 'resend' ? 'Sending…' : 'Send again'}</button>}
      </div>

      <div className="wa-settings-row">
        <label className="wa-switch"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span>Send daily alerts</span></label>
        <label>WhatsApp group name<input value={form.groupName} maxLength={100} placeholder="Exact group name, e.g. JPM Attendance" onChange={(event) => setForm({ ...form, groupName: event.target.value })} /></label>
        <label>Send time<input type="time" value={form.sendTime} onChange={(event) => setForm({ ...form, sendTime: event.target.value })} /></label>
        <button className="button-primary" disabled={saving === 'settings'} onClick={() => void saveSettings()}>{saving === 'settings' ? 'Saving…' : 'Save'}</button>
      </div>
      {message && <p className={message.error ? 'form-error' : 'form-success'}>{message.text}</p>}

      <div className="wa-subheading-row">
        <h3 className="wa-subheading">Departments &amp; HODs <small>use ↑ ↓ to choose which department comes first in the message · HOD is tagged on their department’s lines</small></h3>
        {orderChanged && <button className="button-primary" disabled={saving === 'order'} onClick={() => void saveSettings('order', 'Department order saved.')}>{saving === 'order' ? 'Saving…' : 'Save order'}</button>}
      </div>
      <div className="table-scroll"><table className="wa-table"><thead><tr><th>ORDER</th><th>DEPARTMENT</th><th>HOD NAME</th><th>MOBILE</th><th /></tr></thead><tbody>
        {orderedDepartments.map((dept, index) => <tr key={dept}>
          <td className="wa-order">
            <span>{index + 1}</span>
            <button className="button-tertiary" title="Move up" aria-label={`Move ${dept} up`} disabled={index === 0} onClick={() => moveDepartment(index, -1)}><ArrowUp size={14} /></button>
            <button className="button-tertiary" title="Move down" aria-label={`Move ${dept} down`} disabled={index === orderedDepartments.length - 1} onClick={() => moveDepartment(index, 1)}><ArrowDown size={14} /></button>
          </td>
          <td>{dept}</td>
          <td><input value={hodDrafts[dept]?.name ?? ''} placeholder="HOD name" onChange={(event) => setHodDrafts({ ...hodDrafts, [dept]: { ...hodDrafts[dept], name: event.target.value } })} /></td>
          <td><input inputMode="tel" value={hodDrafts[dept]?.phone ?? ''} placeholder="98765 43210" onChange={(event) => setHodDrafts({ ...hodDrafts, [dept]: { ...hodDrafts[dept], phone: event.target.value } })} /></td>
          <td><button className="button-secondary" disabled={saving === `hod-${dept}`} onClick={() => void saveHod(dept)}>{saving === `hod-${dept}` ? '…' : 'Save'}</button></td>
        </tr>)}
      </tbody></table></div>

      <h3 className="wa-subheading">Employee mobile numbers <small>{withPhone} of {employees.length} added · employees without a number are listed by name only</small></h3>
      <label className="table-search wa-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, ID or department" /></label>
      <div className="table-scroll wa-phone-list"><table className="wa-table"><thead><tr><th>EMPLOYEE</th><th>DEPARTMENT</th><th>MOBILE</th><th /></tr></thead><tbody>
        {filtered.map((employee) => {
          const saved = data.phones[employee.id] ? displayPhone(data.phones[employee.id]) : '';
          const draft = phoneDrafts[employee.id] ?? '';
          return <tr key={employee.id}>
            <td>{employee.name}<small className="wa-id">{employee.id}</small></td>
            <td>{employee.department}</td>
            <td><input inputMode="tel" value={draft} placeholder="98765 43210" onChange={(event) => setPhoneDrafts({ ...phoneDrafts, [employee.id]: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void savePhone(employee); }} /></td>
            <td><button className="button-secondary" disabled={draft === saved || saving === `phone-${employee.id}`} onClick={() => void savePhone(employee)}>{saving === `phone-${employee.id}` ? '…' : 'Save'}</button></td>
          </tr>;
        })}
        {!filtered.length && <tr><td className="empty-table" colSpan={4}>No employees match this search.</td></tr>}
      </tbody></table></div>
    </>}
  </section>;
}

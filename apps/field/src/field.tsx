/**
 * The field app's state (layer-4 plan §4–§6): sign-in, the PIN lock, the
 * encrypted store, the sync loop, check-in and the area package, the
 * check-in timer, location while checked in, and every action the
 * volunteer takes, each saved on the phone first as an outbox command
 * (FLD-13) and sent when there is signal. Screens read this context and call
 * its actions; nothing in a screen talks to the server directly.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';
import {
  confirmTimer,
  distanceM,
  hazardsAround,
  locationPolicy,
  PhotoQueue,
  purgePersonalData,
  startTimer,
  SyncLoop,
  thinFixes,
  type FieldStore,
  type HazardArea,
  type LocationPolicy,
  type OutboxCommand,
  type PhotoDoc,
  type SyncStatus,
  type TimerState,
} from '@cg/field-core';
import { Api, ApiError, OfflineError, type CheckIn, type Me, type VoiceDraft } from './api';
import { takePhoto } from './camera';
import * as auth from './auth';
import { loadConfig, type FieldConfig } from './config';
import { deviceLocale, LocaleContext, translate, type Locale, type MessageKey } from './i18n';
import { currentFix, startLocation, stopLocation, type Fix } from './location';
import { deviceLanguage, loadPrefs, savePrefs } from './prefs';
import { defaultSettings, themeFor, type Settings, type Theme } from './theme';
import * as vault from './vault';

export type Phase = 'loading' | 'signed_out' | 'locked' | 'set_pin' | 'ready' | 'wiped';

export interface Assignment {
  id: string;
  version: number;
  state: string;
  missionId: string;
  reference?: string;
  teamId: string | null;
  personnelId: string | null;
  syncState?: string;
}
export interface Mission {
  id: string;
  version: number;
  reference: string;
  kind: string;
  state: string;
  priority: string;
  urgency: string;
  summary: string | null;
  location: {
    line1: string | null;
    city: string | null;
    landmark: string | null;
    usng: string | null;
    position: { lat: number; lon: number } | null;
  } | null;
}
export interface Message {
  id: string;
  kind: string;
  body: string;
  priority: string;
  requiresAck: boolean;
  sentAt: string | null;
  receipt: { id: string; readAt: string | null; acknowledgedAt: string | null } | null;
  syncState?: string;
}
export interface Team {
  id: string;
  name: string;
  callsign: string | null;
  checkInIntervalMinutes: number;
  status: string | null;
  statusAt: string | null;
}

interface FieldState {
  phase: Phase;
  config: FieldConfig | null;
  me: Me | null;
  locale: Locale;
  settings: Settings;
  theme: Theme;
  checkIn: CheckIn | null;
  team: Team | null;
  assignments: (Assignment & { mission: Mission | null })[];
  messages: Message[];
  hazards: HazardArea[];
  areaSummary: { assignments: number; parcels: number; hazards: number; asOf: string } | null;
  areaState: 'idle' | 'downloading' | 'ready' | 'failed';
  sync: SyncStatus;
  outbox: OutboxCommand[];
  /** Photos on this phone (FLD-07): untagged, waiting for their record, or sent. */
  photos: PhotoDoc[];
  timer: TimerState | null;
  fix: Fix | null;
  policy: LocationPolicy;
  notice: string | null;
  can: (action: string) => boolean;
}

interface FieldActions {
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  signIn(realm: string): Promise<void>;
  completeSignIn(): Promise<void>;
  createPin(pin: string): Promise<void>;
  unlock(pin: string): Promise<{ ok: boolean; triesLeft?: number }>;
  unlockWithBiometrics(): Promise<boolean>;
  biometrics(): Promise<boolean>;
  checkInWithCode(code: string, share: boolean): Promise<string | null>;
  downloadArea(): Promise<void>;
  weAreOk(): Promise<void>;
  acknowledgeAssignment(id: string): Promise<void>;
  acknowledgeMessage(id: string): Promise<void>;
  raiseHelp(note?: string): Promise<'queued' | 'sent'>;
  syncNow(): Promise<void>;
  discard(commandId: string): Promise<void>;
  checkOut(): Promise<void>;
  signOut(): Promise<void>;
  setLocale(l: Locale): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setSharing(on: boolean): Promise<void>;
  clearNotice(): void;
  /** Read a local collection (parcels, sites, job aids, assessments…). */
  list<T extends object>(collection: string): Promise<T[]>;
  /** Keep a small piece of screen state on the phone (a sweep in progress). */
  saveDoc(collection: string, doc: { id: string; [k: string]: unknown }): Promise<void>;
  setAssignmentStatus(id: string, to: 'en_route' | 'on_scene' | 'cleared'): Promise<void>;
  /** FLD-07: take a photo first; it waits on the phone until it is attached to a record. */
  takePhoto(fromLibrary?: boolean): Promise<PhotoDoc | 'denied' | null>;
  removePhoto(id: string): Promise<boolean>;
  /** FLD-09: fields drafted from the volunteer's words, or why there are none. */
  voiceDraft(
    clientUuid: string,
    text: string,
  ): Promise<VoiceDraft | { off: string } | { offline: true }>;
  recordAssessment(input: AssessmentInput): Promise<string>;
  /** Sweep undo: removes a record that has not left the phone; false once it was sent. */
  withdraw(commandId: string): Promise<boolean>;
  quickReport(input: {
    kind: string;
    severity: string;
    summary?: string;
    position?: { lat: number; lon: number; accuracyM?: number };
    photoIds?: string[];
  }): Promise<void>;
  logService(kind: string, count: number, siteId?: string): Promise<void>;
  census(siteId: string, occupancy: number, status?: string): Promise<void>;
  needDone(needId: string, note: string, photoIds?: string[]): Promise<void>;
  /** Online lists the phone does not keep (needs held by the crew's organization). */
  online<T>(path: string): Promise<T>;
  /** Online steps that must be checked by the server before anyone acts on them (a child's pickup code). */
  send<T>(
    method: 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T>;
  /** A frontline role record (task J), kept on the phone and sent as `record.<kind>`. */
  saveRecord(
    kind: string,
    body: Record<string, unknown>,
    summary: string,
    opts?: { photoIds?: string[]; attachPosition?: boolean },
  ): Promise<string>;
  /** A next step on a record the server already has (a road reopens, an interpreter accepts). */
  recordStep(kind: string, targetId: string, body?: Record<string, unknown>): Promise<void>;
}

export interface AssessmentInput {
  /** The phone's id for the record, when the screen already used it (a voice draft is filed under it). */
  id?: string;
  mode: 'sweep' | 'detailed' | 'validation';
  parcelId?: string;
  address?: string | null;
  position?: { lat: number; lon: number; accuracyM?: number };
  landmark?: string;
  structure: string;
  degree: string;
  observations?: Record<string, string | number | boolean | string[]>;
  note?: string;
  missionId?: string;
  assignmentId?: string;
  photoIds?: string[];
}

const Ctx = createContext<(FieldState & FieldActions) | null>(null);

export function useField(): FieldState & FieldActions {
  const v = useContext(Ctx);
  if (!v) throw new Error('useField outside FieldProvider');
  return v;
}

const emptySync: SyncStatus = {
  phase: 'idle',
  pending: 0,
  conflicts: 0,
  lastSyncAt: null,
  lastError: null,
  backoffMs: 0,
};

export function FieldProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [config, setConfig] = useState<FieldConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [locale, setLocaleState] = useState<Locale>('en');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [checkIn, setCheckIn] = useState<CheckIn | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [assignments, setAssignments] = useState<FieldState['assignments']>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hazards, setHazards] = useState<HazardArea[]>([]);
  const [areaSummary, setAreaSummary] = useState<FieldState['areaSummary']>(null);
  const [areaState, setAreaState] = useState<FieldState['areaState']>('idle');
  const [sync, setSync] = useState<SyncStatus>(emptySync);
  const [outbox, setOutbox] = useState<OutboxCommand[]>([]);
  const [photos, setPhotos] = useState<PhotoDoc[]>([]);
  const [timer, setTimer] = useState<TimerState | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [urgent, setUrgent] = useState(false);

  const store = useRef<FieldStore | null>(null);
  const loop = useRef<SyncLoop | null>(null);
  const photoQueue = useRef<PhotoQueue | null>(null);
  const api = useRef<Api>(new Api(''));
  const fixes = useRef<Fix[]>([]);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );
  const theme = useMemo(() => themeFor(settings), [settings]);
  const policy = useMemo(
    () =>
      locationPolicy({
        checkedIn: !!checkIn && !checkIn.endedAt,
        locationSharing: !!checkIn?.locationSharing,
        batterySaver: settings.batterySaver,
        batteryLevel: null,
        charging: false,
        movedM: null,
        urgent,
      }),
    [checkIn, settings.batterySaver, urgent],
  );
  const can = useCallback((action: string) => !!me?.actions.includes(action), [me]);

  // ------------------------------------------------------------ refresh
  const refresh = useCallback(async () => {
    const s = store.current;
    if (!s) return;
    const [as, ms, msgs, hz, tm, cmds, ci] = await Promise.all([
      s.list<Assignment>('assignments'),
      s.list<Mission>('missions'),
      s.list<Message>('messages'),
      s.list<HazardArea>('hazards'),
      s.list<Team & { id: string }>('teams'),
      loop.current?.outbox.all() ?? Promise.resolve([]),
      s.getMeta('checkin'),
    ]);
    const open = as.filter((a) => !['released', 'cleared', 'declined'].includes(a.state));
    setAssignments(
      open.map((a) => ({ ...a, mission: ms.find((m) => m.id === a.missionId) ?? null })),
    );
    setMessages(msgs.sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? '')));
    setHazards(hz.filter((h) => h.state !== 'cleared'));
    setOutbox(cmds);
    setPhotos((await photoQueue.current?.all()) ?? []);
    const current = ci ? (JSON.parse(ci) as CheckIn) : null;
    setCheckIn(current);
    const myTeam = current?.teamId ? (tm.find((x) => x.id === current.teamId) ?? null) : null;
    setTeam(myTeam);
    const timerRaw = await s.getMeta('timer');
    setTimer(timerRaw ? (JSON.parse(timerRaw) as TimerState) : null);
    const area = await s.getMeta('area');
    setAreaSummary(area ? (JSON.parse(area) as FieldState['areaSummary']) : null);
  }, []);

  const runSync = useCallback(async () => {
    if (!loop.current) return;
    const result = await loop.current.runOnce();
    // Photos follow their records (FLD-07); a lost connection keeps them for the next try.
    if (photoQueue.current && result.ok !== false) {
      await photoQueue.current.runOnce(api.current);
      await photoQueue.current.pruneReceived(24 * 3_600_000);
    }
    await refresh();
  }, [refresh]);

  /** Debounced: an action saved on the phone tries to leave within a second. */
  const kick = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => void runSync(), 800);
  }, [runSync]);

  // ------------------------------------------------------------- startup
  useEffect(() => {
    void (async () => {
      const prefs = await loadPrefs();
      setSettings(prefs.settings);
      setLocaleState(prefs.locale ?? deviceLocale(deviceLanguage()));
      const cfg = await loadConfig();
      setConfig(cfg);
      api.current = new Api(cfg.apiBase);
      const session = await auth.loadSession();
      if (!session) {
        setPhase('signed_out');
        return;
      }
      setPhase((await vault.hasPin()) ? 'locked' : 'set_pin');
    })();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined')
      document.documentElement.lang = locale;
  }, [locale]);

  const afterUnlock = useCallback(
    async (s: FieldStore) => {
      store.current = s;
      loop.current = new SyncLoop(s, api.current, {
        events: {
          onStatus: (st) => setSync({ ...st }),
          onWipe: () => {
            void vault.wipeVault().then(() => auth.saveSession(null));
            store.current = null;
            loop.current = null;
            photoQueue.current = null;
            setPhase('wiped');
          },
        },
      });
      photoQueue.current = new PhotoQueue(s, loop.current.outbox, {
        isOffline: (err) => err instanceof OfflineError,
      });
      setPhase('ready');
      try {
        const who = await api.current.me();
        setMe(who);
        await s.setMeta('me', JSON.stringify(who));
      } catch {
        const cached = await s.getMeta('me');
        if (cached) setMe(JSON.parse(cached) as Me);
      }
      // FLD-02: register this install once; the device id rides on every sync so a wipe reaches it.
      if (!(await s.getMeta('device.id'))) {
        try {
          const d = await api.current.registerDevice({
            installId: vault.installId(),
            platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
            managed: false,
            appVersion: '0.0.0',
          });
          await s.setMeta('device.id', d.id);
        } catch {
          /* offline: registered on a later start */
        }
      }
      // A shift opened elsewhere (or before a reinstall) is picked up.
      if (!(await s.getMeta('checkin'))) {
        try {
          const open = await api.current.openCheckIn();
          if (open) await s.setMeta('checkin', JSON.stringify(open));
        } catch {
          /* offline */
        }
      }
      await refresh();
      void runSync();
    },
    [refresh, runSync],
  );

  // Periodic sync while unlocked, and when the app comes back to the foreground (sync on any connection, FLD-13).
  useEffect(() => {
    if (phase !== 'ready') return;
    const every = setInterval(() => void runSync(), 30_000);
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void runSync();
    });
    const online = () => void runSync();
    if (Platform.OS === 'web' && typeof window !== 'undefined')
      window.addEventListener('online', online);
    return () => {
      clearInterval(every);
      sub.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined')
        window.removeEventListener('online', online);
    };
  }, [phase, runSync]);

  // Location only while checked in with sharing on (DSP-08); fixes leave as batches through the outbox.
  useEffect(() => {
    if (phase !== 'ready') return;
    let flush: ReturnType<typeof setInterval> | null = null;
    void startLocation(policy, (f) => {
      setFix(f);
      fixes.current.push(f);
    });
    if (policy.enabled)
      flush = setInterval(() => {
        const batch = thinFixes(fixes.current, policy, new Date(), distanceM);
        fixes.current = [];
        if (!batch.length || !loop.current) return;
        void loop.current.outbox
          .enqueue({ kind: 'position.batch', body: { positions: batch, source: 'app' } })
          .then(kick);
      }, policy.uploadEveryS * 1000);
    return () => {
      if (flush) clearInterval(flush);
      void stopLocation();
    };
  }, [phase, policy, kick]);

  // ------------------------------------------------------------- actions
  const enqueue = useCallback(
    async (input: Parameters<SyncLoop['outbox']['enqueue']>[0]) => {
      if (!loop.current) throw new Error('locked');
      const cmd = await loop.current.outbox.enqueue(input);
      await refresh();
      kick();
      return cmd;
    },
    [refresh, kick],
  );

  const actions: FieldActions = {
    t,
    async signIn(realm) {
      const s = await auth.beginSignIn(config?.apiBase ?? '', realm.trim().toLowerCase());
      if (s) setPhase((await vault.hasPin()) ? 'locked' : 'set_pin');
    },
    async completeSignIn() {
      await auth.completeSignIn(config?.apiBase ?? '');
      setPhase((await vault.hasPin()) ? 'locked' : 'set_pin');
    },
    async createPin(pin) {
      await afterUnlock(await vault.createVault(pin));
    },
    async unlock(pin) {
      const r = await vault.unlockVault(pin);
      if (r.ok) {
        await afterUnlock(r.store);
        return { ok: true };
      }
      if (r.wiped) {
        await auth.saveSession(null);
        setNotice(t('unlock.wiped'));
        setPhase('signed_out');
      }
      return { ok: false, triesLeft: r.triesLeft };
    },
    async unlockWithBiometrics() {
      const s = await vault.unlockWithBiometrics();
      if (!s) return false;
      await afterUnlock(s);
      return true;
    },
    biometrics: () => vault.biometricsAvailable(),
    async checkInWithCode(code, share) {
      const s = store.current;
      if (!s) return 'locked';
      try {
        const deviceId = (await s.getMeta('device.id')) ?? undefined;
        const ci = await api.current.checkIn({
          eventCode: code.trim(),
          locationSharing: share,
          ...(deviceId ? { deviceId } : {}),
        });
        await s.setMeta('checkin', JSON.stringify(ci));
        if (ci.teamId) {
          const rec = await api.current.fetchRecords([{ type: 'team', id: ci.teamId }]);
          const team = rec[0]?.record as (Team & { id: string }) | null | undefined;
          if (team) await s.put('teams', { ...team, id: ci.teamId });
          await s.setMeta(
            'timer',
            JSON.stringify(
              startTimer(
                new Date(team?.statusAt ?? ci.startedAt),
                team?.checkInIntervalMinutes ?? 60,
              ),
            ),
          );
        }
        await refresh();
        return null;
      } catch (err) {
        if (err instanceof OfflineError) return t('checkin.offline');
        if (err instanceof ApiError) return t('checkin.error', { reason: err.message });
        return t('common.error', { reason: String(err) });
      }
    },
    async downloadArea() {
      const s = store.current;
      if (!s) return;
      setAreaState('downloading');
      try {
        const pkg = await api.current.area(checkIn?.eventId ?? null, locale);
        for (const a of pkg.assignments) {
          await s.put('assignments', {
            id: a.id,
            version: a.version,
            state: a.state,
            missionId: a.mission.id,
            reference: a.mission.reference,
            teamId: a.teamId,
            personnelId: a.personnelId,
            syncState: 'received',
          });
          await s.put('missions', { ...a.mission, syncState: 'received' });
        }
        await s.clear('parcels');
        for (const p of pkg.parcels) await s.put('parcels', { ...p });
        for (const h of pkg.hazards) await s.put('hazards', { ...h, syncState: 'received' });
        for (const x of pkg.sites) await s.put('sites', { ...x });
        await s.clear('job_aids');
        for (const j of pkg.jobAids) await s.put('job_aids', { ...j });
        await s.setMeta(
          'area',
          JSON.stringify({
            assignments: pkg.assignments.length,
            parcels: pkg.parcels.length,
            hazards: pkg.hazards.length,
            asOf: pkg.asOf,
          }),
        );
        setAreaState('ready');
      } catch {
        setAreaState('failed');
      }
      await refresh();
    },
    async weAreOk() {
      const s = store.current;
      if (!s || !checkIn?.teamId) return;
      await enqueue({
        kind: 'team.status',
        targetId: checkIn.teamId,
        body: {
          status: team?.status && team.status !== 'overdue' ? team.status : 'available',
          source: 'app',
          note: 'We are OK',
        },
      });
      const next = timer
        ? confirmTimer(timer, new Date())
        : startTimer(new Date(), team?.checkInIntervalMinutes ?? 60);
      await s.setMeta('timer', JSON.stringify(next));
      setTimer(next);
    },
    async acknowledgeAssignment(id) {
      const s = store.current;
      const a = s ? await s.get<Assignment>('assignments', id) : null;
      if (!s || !a) return;
      await s.put('assignments', { ...a, state: 'acknowledged', syncState: 'on_this_phone' });
      await enqueue({
        kind: 'assignment.acknowledge',
        targetId: id,
        version: a.version,
        body: { accept: true },
        localRef: { collection: 'assignments', id },
      });
    },
    async acknowledgeMessage(id) {
      const s = store.current;
      const m = s ? await s.get<Message>('messages', id) : null;
      if (!s || !m) return;
      const now = new Date().toISOString();
      await s.put('messages', {
        ...m,
        receipt: { id: m.receipt?.id ?? id, readAt: now, acknowledgedAt: now },
        syncState: 'on_this_phone',
      });
      const deviceId = (await s.getMeta('device.id')) ?? undefined;
      await enqueue({
        kind: 'field_message.receipt',
        targetId: id,
        body: { read: true, acknowledged: true, ...(deviceId ? { deviceId } : {}) },
        localRef: { collection: 'messages', id },
      });
    },
    async raiseHelp(note) {
      setUrgent(true);
      const f = await currentFix();
      const cmd = await enqueue({
        kind: 'safety_alert.raise',
        body: {
          kind: 'help_button',
          ...(f
            ? {
                position: {
                  lat: f.lat,
                  lon: f.lon,
                  ...(f.accuracyM !== null ? { accuracyM: f.accuracyM } : {}),
                  at: f.recordedAt,
                },
              }
            : {}),
          ...(note ? { note } : {}),
        },
      });
      if (syncTimer.current) clearTimeout(syncTimer.current);
      await runSync();
      const after = await loop.current?.outbox.get(cmd.id);
      return after?.status === 'received' ? 'sent' : 'queued';
    },
    syncNow: runSync,
    async discard(commandId) {
      await loop.current?.outbox.resolve(commandId);
      await refresh();
    },
    async checkOut() {
      const s = store.current;
      if (!s || !checkIn) return;
      await enqueue({
        kind: 'check_in.end',
        targetId: checkIn.id,
        body: { reason: 'checked_out' },
      });
      await runSync();
      // FLD-14: resident details leave the phone at check-out; unsent work stays until it is received.
      await purgePersonalData(s, 'check_out');
      await s.setMeta('checkin', null);
      await s.setMeta('timer', null);
      setUrgent(false);
      await refresh();
    },
    async signOut() {
      await auth.signOut();
      store.current = null;
      loop.current = null;
      photoQueue.current = null;
      setMe(null);
      setPhase('signed_out');
    },
    async setLocale(l) {
      setLocaleState(l);
      await savePrefs({ locale: l, settings });
    },
    async updateSettings(patch) {
      const next = { ...settings, ...patch };
      setSettings(next);
      await savePrefs({ locale, settings: next });
    },
    async setSharing(on) {
      const s = store.current;
      if (!s || !checkIn) return;
      const next = { ...checkIn, locationSharing: on };
      await s.setMeta('checkin', JSON.stringify(next));
      setCheckIn(next);
    },
    clearNotice: () => setNotice(null),
    async list<T extends object>(collection: string) {
      return (await store.current?.list<T>(collection)) ?? [];
    },
    async saveDoc(collection, doc) {
      await store.current?.put(collection, doc);
    },
    async setAssignmentStatus(id, to) {
      const s = store.current;
      const a = s ? await s.get<Assignment>('assignments', id) : null;
      if (!s || !a) return;
      await s.put('assignments', { ...a, state: to, syncState: 'on_this_phone' });
      // RULE-03, DSP-05: each fact on its own, confirmed by the person; never inferred from location.
      await enqueue({
        kind: 'assignment.status',
        targetId: id,
        version: a.version,
        body: { to, at: new Date().toISOString() },
        localRef: { collection: 'assignments', id },
      });
    },
    async takePhoto(fromLibrary) {
      const q = photoQueue.current;
      if (!q) return null;
      const shot = await takePhoto(fromLibrary);
      if (!shot || shot === 'denied') return shot;
      const f = fix ?? (await currentFix());
      const doc = await q.add({
        ...shot,
        ...(f ? { position: { lat: f.lat, lon: f.lon } } : {}),
      });
      await refresh();
      return doc;
    },
    async removePhoto(id) {
      const ok = (await photoQueue.current?.remove(id)) ?? false;
      await refresh();
      return ok;
    },
    async voiceDraft(clientUuid, text) {
      try {
        return await api.current.voiceDraft({ clientUuid, text, language: locale });
      } catch (err) {
        if (err instanceof OfflineError) return { offline: true as const };
        if (err instanceof ApiError && err.code === 'ai_off') return { off: t('voice.off') };
        if (err instanceof ApiError) return { off: t('voice.failed') };
        throw err;
      }
    },
    async recordAssessment(input) {
      const s = store.current;
      if (!s) throw new Error('locked');
      const id = input.id ?? globalThis.crypto.randomUUID();
      const body: Record<string, unknown> = {
        mode: input.mode,
        structure: input.structure,
        degree: input.degree,
        ...(input.parcelId ? { parcelId: input.parcelId } : {}),
        ...(input.position ? { position: input.position } : {}),
        ...(input.landmark ? { landmark: input.landmark } : {}),
        ...(input.observations ? { observations: input.observations } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.missionId ? { missionId: input.missionId } : {}),
        ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
        ...(checkIn?.eventId ? { eventId: checkIn.eventId } : {}),
      };
      // The local record keeps only what the volunteer needs to see; no resident details are asked for (FLD-14).
      await s.put('assessments', {
        id,
        parcelId: input.parcelId ?? null,
        address: input.address ?? null,
        landmark: input.landmark ?? null,
        degree: input.degree,
        structure: input.structure,
        mode: input.mode,
        at: new Date().toISOString(),
        syncState: 'on_this_phone',
      });
      if (input.photoIds?.length) await photoQueue.current?.tag(input.photoIds, id);
      await enqueue({
        id,
        kind: 'assessment.record',
        body,
        localRef: { collection: 'assessments', id },
      });
      return id;
    },
    async withdraw(commandId) {
      const s = store.current;
      const cmd = await loop.current?.outbox.get(commandId);
      if (!s || !cmd || cmd.status !== 'on_this_phone') return false;
      await loop.current!.outbox.resolve(commandId);
      if (cmd.localRef) await s.delete(cmd.localRef.collection, cmd.localRef.id);
      await refresh();
      return true;
    },
    async quickReport(input) {
      if (!checkIn?.eventId) return;
      const id = globalThis.crypto.randomUUID();
      if (input.photoIds?.length) await photoQueue.current?.tag(input.photoIds, id);
      await enqueue({
        id,
        kind: 'hazard.report',
        body: {
          eventId: checkIn.eventId,
          kind: input.kind,
          severity: input.severity,
          source: 'field',
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.position ? { position: input.position } : {}),
        },
      });
    },
    async logService(kind, count, siteId) {
      await enqueue({
        kind: 'service_log.record',
        body: { kind, count, ...(siteId ? { siteId } : {}), occurredAt: new Date().toISOString() },
      });
    },
    async census(siteId, occupancy, status) {
      await enqueue({
        kind: 'site.census',
        targetId: siteId,
        body: { occupancy, ...(status ? { status } : {}) },
      });
    },
    async needDone(needId, note, photoIds) {
      const id = globalThis.crypto.randomUUID();
      if (photoIds?.length) await photoQueue.current?.tag(photoIds, id);
      await enqueue({ id, kind: 'need.done', targetId: needId, body: { note } });
    },
    online: <T,>(path: string) => api.current.call<T>('GET', path),
    send: <T,>(
      method: 'POST' | 'PATCH',
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => api.current.call<T>(method, path, body ?? {}, headers),
    async saveRecord(kind, body, summary, opts) {
      const s = store.current;
      if (!s) throw new Error('locked');
      const id = globalThis.crypto.randomUUID();
      // The phone keeps a plain line to show; the details travel encrypted in the outbox (FLD-14).
      await s.put('role_records', {
        id,
        kind,
        summary,
        at: new Date().toISOString(),
        syncState: 'on_this_phone',
      });
      if (opts?.photoIds?.length) await photoQueue.current?.tag(opts.photoIds, id);
      const f = opts?.attachPosition ? (fix ?? (await currentFix())) : null;
      await enqueue({
        id,
        kind: `record.${kind}`,
        body: {
          ...body,
          ...(checkIn?.eventId && !body['eventId'] ? { eventId: checkIn.eventId } : {}),
          ...(f && body['position'] === undefined
            ? {
                position: {
                  lat: f.lat,
                  lon: f.lon,
                  ...(f.accuracyM !== null ? { accuracyM: f.accuracyM } : {}),
                },
              }
            : {}),
        },
        localRef: { collection: 'role_records', id },
      });
      return id;
    },
    async recordStep(kind, targetId, body) {
      await enqueue({ kind: `record.${kind}`, targetId, body: body ?? {} });
    },
  };

  const value: FieldState & FieldActions = {
    phase,
    config,
    me,
    locale,
    settings,
    theme,
    checkIn,
    team,
    assignments,
    messages,
    hazards,
    areaSummary,
    areaState,
    sync,
    outbox,
    photos,
    timer,
    fix,
    policy,
    notice,
    can,
    ...actions,
  };
  return (
    <LocaleContext.Provider value={{ locale, t }}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </LocaleContext.Provider>
  );
}

/** Hazards the current fix is inside or about to enter (FLD-16). */
export function useHazardWarnings() {
  const { fix, hazards } = useField();
  return useMemo(() => (fix ? hazardsAround(fix, hazards) : []), [fix, hazards]);
}

/**
 * The design showcase: every token and component in one page, with the staff
 * shell around it, so a person can look and axe can check (ADR-0045). Synthetic
 * content only (SCL-12); the product name is a placeholder, never hardcoded
 * elsewhere (ADM-03).
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/fonts-staff.css';
import '../styles/index.css';
import {
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  DecisionCard,
  DecisionList,
  Dialog,
  DialogTrigger,
  Disclosure,
  EmptyState,
  EventChip,
  Kbd,
  LinkButton,
  Menu,
  MenuItem,
  MenuSection,
  Notice,
  Option,
  PageHeader,
  PersonMenu,
  Pill,
  Radio,
  RadioGroup,
  Select,
  Shell,
  SideNav,
  Skeleton,
  StatTile,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextArea,
  TextField,
  Tiles,
  Timeline,
  Toolbar,
  Tooltip,
  TopBar,
  applyMode,
  applyPreferences,
  icons,
  initPreferences,
  readPreferences,
  writePreferences,
  type NavGroup,
  type Preferences,
} from '../index.ts';

const PRODUCT = 'Showcase';
const NOW = Date.parse('2026-10-15T16:04:00Z');

const groups: NavGroup[] = [
  {
    title: 'Situation',
    items: [
      { path: '/', label: 'Situation', icon: icons.Gauge },
      { path: '/map', label: 'Situation map', icon: icons.Map },
      {
        path: '/recommendations',
        label: 'Recommendations',
        icon: icons.Sparkles,
        count: 1,
        countLabel: 'awaiting a decision',
      },
    ],
  },
  {
    title: 'Intake and review',
    items: [
      {
        path: '/reports',
        label: 'Review queue',
        icon: icons.Inbox,
        count: 874,
        countLabel: 'in the queue',
      },
      { path: '/assist', label: 'Assisted report', icon: icons.UserCheck },
      { path: '/intake', label: 'Intake setup', icon: icons.ClipboardList },
    ],
  },
  {
    title: 'Mass care and needs',
    items: [
      {
        path: '/needs',
        label: 'Needs board',
        icon: icons.HeartHandshake,
        count: 612,
        countLabel: 'open',
      },
      { path: '/sites', label: 'Sites', icon: icons.Tent },
      { path: '/shelters', label: 'Shelters', icon: icons.Building2 },
    ],
  },
  {
    title: 'Field operations',
    items: [
      {
        path: '/dispatch',
        label: 'Dispatch board',
        icon: icons.Radio,
        count: 1,
        countLabel: 'overdue',
        countTone: 'danger',
      },
      { path: '/missions', label: 'Missions', icon: icons.Truck },
    ],
  },
  {
    title: 'Administration',
    items: [
      { path: '/accounts', label: 'Staff accounts', icon: icons.Users },
      { path: '/audit', label: 'Audit log', icon: icons.ScrollText },
    ],
  },
];

function Controls({ prefs, setPrefs }: { prefs: Preferences; setPrefs: (p: Preferences) => void }) {
  const [briefing, setBriefing] = useState(false);
  useEffect(() => applyMode(briefing ? 'briefing' : 'normal'), [briefing]);
  return (
    <Toolbar label="Showcase display">
      <Button
        aria-pressed={prefs.theme === 'light'}
        onPress={() => setPrefs({ ...prefs, theme: 'light' })}
        icon={icons.Sun}
        data-testid="theme-light"
      >
        Light
      </Button>
      <Button
        aria-pressed={prefs.theme === 'dark'}
        onPress={() => setPrefs({ ...prefs, theme: 'dark' })}
        icon={icons.Moon}
        data-testid="theme-dark"
      >
        Dark
      </Button>
      <Button
        aria-pressed={prefs.density === 'compact'}
        onPress={() =>
          setPrefs({ ...prefs, density: prefs.density === 'compact' ? 'comfortable' : 'compact' })
        }
        icon={icons.Rows3}
      >
        Compact
      </Button>
      <Button aria-pressed={briefing} onPress={() => setBriefing((b) => !b)} icon={icons.Tv}>
        Briefing mode
      </Button>
    </Toolbar>
  );
}

function Swatches() {
  const names = [
    'bg',
    'surface',
    'surface-2',
    'line',
    'ink',
    'ink-2',
    'accent',
    'accent-soft',
    'ok-bg',
    'warn-bg',
    'danger-bg',
    'info-bg',
    'ai-bg',
  ];
  return (
    <ul style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', listStyle: 'none', padding: 0 }}>
      {names.map((n) => (
        <li key={n} style={{ display: 'grid', gap: '0.25rem', justifyItems: 'center' }}>
          <span
            aria-hidden="true"
            style={{
              display: 'block',
              inlineSize: '3rem',
              blockSize: '3rem',
              borderRadius: 'var(--cg-radius-md)',
              background: `var(--cg-${n})`,
              border: '1px solid var(--cg-line-strong)',
            }}
          />
          <code className="small">{n}</code>
        </li>
      ))}
    </ul>
  );
}

function Page() {
  const [prefs, setPrefsState] = useState<Preferences>(() => readPreferences());
  const setPrefs = (p: Preferences) => {
    setPrefsState(p);
    writePreferences(p);
    applyPreferences(p);
  };
  const [path, setPath] = useState('/');
  const [choice, setChoice] = useState('shelter');
  return (
    <Shell
      topBar={
        <TopBar
          product={PRODUCT}
          county="Westwind County Emergency Management"
          onNavigate={setPath}
          end={
            <PersonMenu
              name="Dana Reyes"
              role="County EM director"
              theme={prefs.theme}
              density={prefs.density}
              onTheme={(t) => setPrefs({ ...prefs, theme: t })}
              onDensity={(d) => setPrefs({ ...prefs, density: d })}
              onSignOut={() => undefined}
            />
          }
        >
          <EventChip
            name="WESTWIND"
            hazard="tornado"
            status="active"
            openedAt="2026-10-14T01:00:00Z"
            now={NOW}
          />
          <button type="button" className="cg-command-open" aria-keyshortcuts="Control+K">
            <icons.Search width={16} height={16} aria-hidden="true" />
            <span className="cg-command-open__text">
              Ask or do anything: “draft the 2 pm sitrep”
            </span>
            <Kbd>Ctrl K</Kbd>
          </button>
        </TopBar>
      }
      banner={null}
      nav={({ id, open, close }) => (
        <SideNav
          groups={groups}
          currentPath={path}
          id={id}
          open={open}
          onNavigate={(to) => {
            setPath(to);
            close();
          }}
        />
      )}
    >
      <PageHeader
        title="Design showcase"
        lede="Every token and component, in both themes, for the eye and for the accessibility checks."
      />
      <Controls prefs={prefs} setPrefs={setPrefs} />

      <h2>Colour</h2>
      <Swatches />

      <h2>Type</h2>
      <p style={{ fontSize: 'var(--cg-text-3xl)', fontWeight: 600, margin: 0 }}>
        Resident reports 1,612
      </p>
      <p style={{ fontSize: 'var(--cg-text-xl)', margin: 0 }}>Needs your decision</p>
      <p>
        Body text at 16 px with a 1.5 line height. Links look like <a href="#type">this link</a>,
        codes like <code>KXMR-4827</code>, and keys like <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>.
      </p>
      <p className="small muted">Secondary text at 13 px keeps 4.5:1 or better.</p>

      <h2>Tiles</h2>
      <Tiles>
        <StatTile label="Resident reports" value="1,612" detail="+346 since 6 AM · 1,388 homes" />
        <StatTile
          label="Verified homes"
          value="388"
          detail="29 destroyed · 71 major · 104 minor · 184 affected"
        />
        <StatTile
          label="Needs"
          value="612"
          unit="open"
          detail="498 claimed · 126 done"
          tone="warn"
        />
        <StatTile
          label="Declaration window"
          value="28"
          unit="days"
          detail="left of 30 · package 28% verified"
          tone="danger"
          href="/declaration"
          onNavigate={setPath}
        />
      </Tiles>

      <h2 id="decisions-h">Needs your decision</h2>
      <DecisionList aria-labelledby="decisions-h">
        <DecisionCard
          kicker="Recommendation · Mass care"
          title="Distribution point and walk-up site for the outage area"
          tone="ai"
          actions={
            <>
              <Button variant="primary">Review recommendation</Button>
              <Button variant="quiet">Later</Button>
            </>
          }
        >
          Type II drive-through and a walk-up point near Cedar Ridge. Luis reviewed; needs your
          approval.
        </DecisionCard>
        <DecisionCard
          kicker="Coverage alert"
          title="Oak Hollow: 9 reports for 74 homes in the path"
          tone="warn"
          actions={
            <>
              <Button>Assign outreach</Button>
              <Button variant="link">Dismiss with reason</Button>
            </>
          }
        >
          Likely under-reported, not undamaged. Suggested: door hangers and an assisted-reporting
          team.
        </DecisionCard>
      </DecisionList>

      <h2>Buttons</h2>
      <Toolbar>
        <Button variant="primary" icon={icons.Check}>
          Approve
        </Button>
        <Button>Secondary</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="link">Link style</Button>
        <Button variant="danger" icon={icons.Trash2}>
          Delete
        </Button>
        <Button isDisabled>Disabled</Button>
        <Button variant="primary" size="lg">
          Large for residents
        </Button>
        <LinkButton href="#buttons" icon={icons.ExternalLink}>
          Open as link
        </LinkButton>
        <Tooltip text="Refresh the counts">
          <Button icon={icons.RefreshCw} aria-label="Refresh the counts" />
        </Tooltip>
        <button type="button" className="primary">
          Native primary
        </button>
        <button type="button">Native button</button>
        <button type="button" className="link">
          Native link
        </button>
      </Toolbar>

      <h2>Pills and notices</h2>
      <p style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        <Pill tone="ok" dot>
          Open
        </Pill>
        <Pill tone="warn" dot>
          Claimed
        </Pill>
        <Pill tone="danger" dot>
          Overdue
        </Pill>
        <Pill tone="info">Submitted</Pill>
        <Pill tone="ai">AI suggestion, not verified</Pill>
        <Pill>Neutral</Pill>
        <span className="badge badge-open">legacy open</span>
        <span className="badge badge-closed">legacy closed</span>
      </p>
      <Notice tone="ok" title="Saved.">
        The site is published on Find help, the text replies and both feeds.
      </Notice>
      <Notice tone="warn" title="Confirmation lapses in 2 hours.">
        Cedar Ridge shelter was last confirmed at 6:10 AM.
      </Notice>
      <Notice tone="danger" title="Not sent.">
        The queue did not accept the report; it is kept on this device and retried.
      </Notice>
      <Notice tone="ai" title="AI suggestion, not verified.">
        The photo suggests major damage; a credentialed reviewer decides the degree.
      </Notice>
      <p className="status success" role="status">
        Legacy status: saved.
      </p>

      <h2>Fields</h2>
      <div className="form-grid">
        <TextField
          label="Reference number"
          description="Four letters and four digits"
          placeholder="KXMR-4827"
        />
        <TextField label="Address" isInvalid errorMessage="Enter a street address in the county." />
        <Select label="Event" selectedKey={choice} onSelectionChange={(k) => setChoice(String(k))}>
          <Option id="shelter">WESTWIND tornado</Option>
          <Option id="flood">Spring flood exercise</Option>
        </Select>
        <TextArea label="Reason" description="Kept on the record with your name." />
        <div className="field">
          <label htmlFor="legacy-input">Legacy field</label>
          <p className="hint" id="legacy-hint">
            Native input with the shared skin.
          </p>
          <input id="legacy-input" aria-describedby="legacy-hint" />
        </div>
        <div className="field">
          <label htmlFor="legacy-select">Legacy select</label>
          <select id="legacy-select">
            <option>Open</option>
            <option>Full</option>
          </select>
        </div>
      </div>
      <CheckboxGroup label="Services" description="Choose every service this site offers.">
        <Checkbox value="meals">Meals</Checkbox>
        <Checkbox value="pets">Pets welcome</Checkbox>
        <Checkbox value="power">Power for medical devices</Checkbox>
      </CheckboxGroup>
      <RadioGroup label="Verification" defaultValue="field">
        <Radio value="self">Self-reported</Radio>
        <Radio value="field">Field verified</Radio>
        <Radio value="photo">Photo verified</Radio>
      </RadioGroup>
      <Switch defaultSelected>Remember my commands on this device</Switch>
      <label className="choice">
        <input type="checkbox" /> Legacy choice with a native checkbox
      </label>

      <h2>Menus, dialogs, tabs, disclosure</h2>
      <Toolbar>
        <Menu label="More actions" trigger={<Button icon={icons.ChevronDown}>More</Button>}>
          <MenuSection title="Report">
            <MenuItem icon={icons.Download}>Download PDF</MenuItem>
            <MenuItem icon={icons.Printer} shortcut="Ctrl P">
              Print
            </MenuItem>
          </MenuSection>
          <MenuSection>
            <MenuItem icon={icons.Trash2}>Withdraw</MenuItem>
          </MenuSection>
        </Menu>
        <DialogTrigger>
          <Button variant="primary">Open a dialog</Button>
          <Dialog title="Publish this site?">
            {(close) => (
              <>
                <p>
                  Residents will see it on Find help within two minutes. Give a reason for the log.
                </p>
                <TextField label="Reason" autoFocus />
                <div className="cg-actions">
                  <Button variant="quiet" onPress={close}>
                    Cancel
                  </Button>
                  <Button variant="primary" onPress={close}>
                    Publish
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </DialogTrigger>
      </Toolbar>
      <Tabs defaultSelectedKey="list">
        <TabList aria-label="Views">
          <Tab id="list">List</Tab>
          <Tab id="map">Map</Tab>
          <Tab id="log">Log</Tab>
        </TabList>
        <TabPanel id="list">The list view.</TabPanel>
        <TabPanel id="map">The map view, with the same items in a table.</TabPanel>
        <TabPanel id="log">The log.</TabPanel>
      </Tabs>
      <Disclosure summary="What counts as verified?">
        A report counts once it has been approved and verified by a credentialed reviewer; one home
        counts once.
      </Disclosure>

      <h2>Tables and lists</h2>
      <div className="table-wrap" role="region" aria-label="Reports" tabIndex={0}>
        <table>
          <caption>Reports with need signals first</caption>
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Area</th>
              <th scope="col">State</th>
              <th scope="col" className="cg-num">
                Needs
              </th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['KXMR-4827', 'Oak Hollow', 'submitted', 3],
              ['PQTN-1183', 'Cedar Ridge', 'under_review', 1],
              ['WHBF-9020', 'Willow Bend', 'approved', 0],
            ].map(([ref, area, state, needs]) => (
              <tr key={String(ref)}>
                <td>
                  <code>{ref}</code>
                </td>
                <td>{area}</td>
                <td>
                  <span className={`badge badge-${state}`}>{String(state).replace('_', ' ')}</span>
                </td>
                <td className="cg-num">{needs}</td>
                <td>
                  <button type="button" className="link">
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Card
        title={<h3>Significant events</h3>}
        kicker="Updated 10:04 AM · 6 sources"
        actions={<Button variant="link">Full log</Button>}
      >
        <Timeline
          entries={[
            {
              id: '1',
              time: '09:52',
              at: '2026-10-15T14:52:00Z',
              source: 'Utility feed',
              text: 'Restoration estimate for 6,200 customers moved to 3–5 days',
            },
            {
              id: '2',
              time: '09:31',
              at: '2026-10-15T14:31:00Z',
              source: 'Priya (damage)',
              text: 'Field team 3 finished the Willow Bend route: 41 homes verified',
            },
            {
              id: '3',
              time: '08:47',
              at: '2026-10-15T13:47:00Z',
              source: 'Road status',
              text: 'Road closed: debris on the fairgrounds access road',
            },
          ]}
        />
      </Card>
      <dl className="meta">
        <dt>Event</dt>
        <dd>WESTWIND tornado</dd>
        <dt>Opened</dt>
        <dd>14 October, 1:00 AM</dd>
      </dl>
      <EmptyState icon={icons.Inbox} title="Nothing waiting" action={<Button>Refresh</Button>}>
        New reports appear here as residents send them.
      </EmptyState>
      <Card title={<h3>Loading</h3>}>
        <Skeleton lines={3} width="60%" />
      </Card>
    </Shell>
  );
}

initPreferences();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Page />
    </StrictMode>,
  );
}

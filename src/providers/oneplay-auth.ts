import { at, readErrorMessage, type AuthenticationToken } from './oneplay-protocol.ts';
import type { OneplayConnection } from './oneplay-connection.ts';
import type { OneplayConnectionPool } from './oneplay-pool.ts';

/** `OneplayCredentials` fields sourced from `ProviderConfig`; never logged, never persisted. */
export interface OneplayCredentials {
  readonly email: string;
  readonly password: string;
  readonly accountId: string | undefined;
  readonly profileId: string | undefined;
  readonly profilePin: string | undefined;
}

export type AccountProvider = 'ANY' | 'EBOX' | 'O2';

export interface OneplayAccount {
  readonly id: string;
  readonly provider: AccountProvider;
  readonly name: string;
  readonly isActive: boolean;
}

export interface OneplayProfile {
  readonly id: string;
  readonly name: string;
}

export interface AuthenticationData {
  readonly accountId: string;
  readonly profileId: string;
  readonly authToken: AuthenticationToken;
  readonly deviceId: string;
  readonly accounts: readonly OneplayAccount[];
}

const ACCOUNT_PROVIDER_BY_VALUE: Record<string, AccountProvider> = { eBox: 'EBOX', O2: 'O2' };

function accountProviderOf(value: string | undefined): AccountProvider {
  return ACCOUNT_PROVIDER_BY_VALUE[value ?? ''] ?? 'ANY';
}

/** `Authenticator.Accounts.setAccounts(null)`: the single-account fallback shape. */
const DEFAULT_ACCOUNTS: readonly OneplayAccount[] = [
  { id: '', provider: 'EBOX', name: 'Oneplay', isActive: true },
];

function parseAccounts(rawAccounts: readonly unknown[]): OneplayAccount[] {
  return rawAccounts.map((raw) => ({
    id: at<string>(raw, 'accountId') ?? '',
    provider: accountProviderOf(at<string>(raw, 'accountProvider')),
    name: at<string>(raw, 'name') ?? '',
    isActive: at<boolean>(raw, 'isActive') ?? false,
  }));
}

/** `Authenticator.selectAccount`. */
function selectAccount(accounts: readonly OneplayAccount[], accountId: string | undefined): OneplayAccount {
  if (accounts.length === 0) throw new Error('Oneplay login failed: no accounts available');
  const firstActive = accounts.find((account) => account.isActive);
  if (!firstActive) throw new Error('Oneplay login failed: no active account');
  if (!accountId) return firstActive;
  return accounts.find((account) => account.isActive && account.id === accountId) ?? firstActive;
}

/** `Authenticator.selectProfile`. */
function selectProfile(profiles: readonly OneplayProfile[], profileId: string | undefined): OneplayProfile {
  if (profiles.length === 0) throw new Error('Oneplay login failed: account has no profiles');
  const first = profiles[0]!;
  if (!profileId) return first;
  return profiles.find((profile) => profile.id === profileId) ?? first;
}

/** `Authenticator.Profiles.all`. */
async function fetchProfiles(connection: OneplayConnection, signal: AbortSignal): Promise<OneplayProfile[]> {
  const response = await connection.request('user.profiles.display', {}, signal);
  const profiles = at<unknown[]>(response.data, 'availableProfiles.profiles');
  if (response.status !== 'Ok' || !profiles) {
    throw new Error(`Failed to get profiles. Reason: ${readErrorMessage(response.data)}`);
  }
  return profiles.map((profile) => ({
    id: at<string>(profile, 'profile.id') ?? '',
    name: at<string>(profile, 'profile.name') ?? '',
  }));
}

interface SelectedAccount {
  readonly accountId: string;
  readonly authTokenValue: string;
}

/** `Authenticator.doSelectAccount`. */
async function selectAccountStep(
  connection: OneplayConnection,
  account: OneplayAccount,
  authCode: string | undefined,
  signal: AbortSignal,
): Promise<SelectedAccount> {
  if (!account.id) throw new Error('Failed to log in (account step). Cannot find any suitable account.');
  const response = await connection.command(
    'user.login.step',
    'LoginWithAccountCommand',
    { accountId: account.id, authCode },
    signal,
  );
  const authTokenValue = at<string>(response.data, 'step.bearerToken');
  if (response.status !== 'Ok' || !authTokenValue) {
    throw new Error(
      `Failed to log in (account step). Reason: ${readErrorMessage(response.data)}`,
    );
  }
  return { accountId: account.id, authTokenValue };
}

interface LoginStepResult {
  readonly accountId: string;
  readonly authTokenValue: string;
  readonly accounts: readonly OneplayAccount[];
}

/** `Authenticator.doLogin`. */
async function loginWithCredentials(
  connection: OneplayConnection,
  credentials: OneplayCredentials,
  requiredAccountId: string | null,
  signal: AbortSignal,
): Promise<LoginStepResult> {
  const response = await connection.command(
    'user.login.step',
    'LoginWithCredentialsCommand',
    { email: credentials.email, password: credentials.password },
    signal,
  );
  if (response.status !== 'Ok') {
    throw new Error(`Failed to log in. Reason: ${readErrorMessage(response.data)}`);
  }

  const schema = at<string>(response.data, 'step.schema');
  if (schema === 'ShowAccountChooserStep') {
    const groups = at<unknown[]>(response.data, 'step.groups') ?? [];
    const rawAccounts = groups.flatMap((group) => at<unknown[]>(group, 'accounts') ?? []);
    const accounts = parseAccounts(rawAccounts);
    const selectedAccountId = requiredAccountId ?? credentials.accountId;
    const account = selectAccount(accounts, selectedAccountId);
    const authCode = at<string>(response.data, 'step.authToken');
    const selected = await selectAccountStep(connection, account, authCode, signal);
    return { accountId: selected.accountId, authTokenValue: selected.authTokenValue, accounts };
  }

  const authTokenValue = at<string>(response.data, 'step.bearerToken');
  if (!authTokenValue) {
    throw new Error(`Failed to log in. Reason: ${readErrorMessage(response.data)}`);
  }
  return { accountId: '', authTokenValue, accounts: DEFAULT_ACCOUNTS };
}

/** `Authenticator.doSelectProfile`: handles the optional 4-digit profile-PIN challenge. */
async function selectProfileStep(
  connection: OneplayConnection,
  profile: OneplayProfile,
  profilePin: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  let response = await connection.request('user.profile.select', { payload: { profileId: profile.id } }, signal);

  if (response.status !== 'Ok') {
    if (at<string>(response.data, 'result.code') !== '4080') {
      throw new Error(
        `Failed to log in (select profile). Reason: ${readErrorMessage(response.data)}`,
      );
    }
    if (!profilePin || profilePin.length !== 4) {
      throw new Error('Profile PIN is required but is invalid. PIN must have 4 digits.');
    }
    response = await connection.request(
      'user.profile.select',
      {
        payload: { profileId: profile.id },
        authorization: [{ schema: 'PinRequestAuthorization', pin: profilePin, type: 'profile' }],
      },
      signal,
    );
  }

  const authToken = at<string>(response.data, 'bearerToken');
  if (response.status !== 'Ok' || !authToken) {
    throw new Error(
      `Failed to log in (select profile). Reason: ${readErrorMessage(response.data)}`,
    );
  }
  return authToken;
}

/** `Authenticator.currentDeviceId`. */
async function fetchCurrentDeviceId(connection: OneplayConnection, signal: AbortSignal): Promise<string> {
  const response = await connection.request('app.init', { payload: { reason: 'login' } }, signal);
  const deviceId = at<string>(response.data, 'user.currentDevice.id');
  if (response.status !== 'Ok' || !deviceId) {
    throw new Error(`Failed to obtain device ID. Reason: ${readErrorMessage(response.data)}`);
  }
  return deviceId;
}

/**
 * `Authenticator.login`. No on-disk credential cache exists in this headless port (the Java
 * client's `CredentialsManager` has no equivalent here), so every call performs a fresh
 * email+password login; `OneplaySession` below avoids repeating it once already authenticated.
 */
export async function login(
  connection: OneplayConnection,
  credentials: OneplayCredentials,
  requiredAccountId: string | null,
  doProfileSelect: boolean,
  signal: AbortSignal,
): Promise<AuthenticationData> {
  const loginResult = await loginWithCredentials(connection, credentials, requiredAccountId, signal);
  const accountId = loginResult.accountId;
  connection.authenticate({ accountId, type: 'NO_PROFILE', value: loginResult.authTokenValue });

  const profiles = await fetchProfiles(connection, signal);
  const profile = selectProfile(profiles, credentials.profileId);

  if (!doProfileSelect) {
    return {
      accountId,
      profileId: profile.id,
      authToken: { accountId, type: 'NO_PROFILE', value: loginResult.authTokenValue },
      deviceId: '',
      accounts: loginResult.accounts,
    };
  }

  const profileAuthValue = await selectProfileStep(connection, profile, credentials.profilePin, signal);
  const deviceId = await fetchCurrentDeviceId(connection, signal);
  const authToken: AuthenticationToken = { accountId, type: 'FULL', value: profileAuthValue };
  connection.authenticate(authToken);

  return { accountId, profileId: profile.id, authToken, deviceId, accounts: loginResult.accounts };
}

/**
 * `Oneplay.ensureAuthenticated` / `ensureUnauthenticated`: single-flight gate around `login`,
 * tracking whether the pool already holds a token for the required account at the required
 * authentication level (plain login vs. full profile-selected login).
 */
export class OneplaySession {
  private readonly pool: OneplayConnectionPool;
  private readonly credentials: OneplayCredentials;
  private readonly requiredAccountId: string | null;
  private lastAccountId: string | null = null;
  private wasProfileSelect = false;
  private lock: Promise<void> = Promise.resolve();

  constructor(pool: OneplayConnectionPool, credentials: OneplayCredentials, requiredAccountId: string | null) {
    this.pool = pool;
    this.credentials = credentials;
    this.requiredAccountId = requiredAccountId;
  }

  private isSatisfied(doProfileSelect: boolean): boolean {
    return (
      this.pool.isAuthenticated() &&
      (this.requiredAccountId === null || this.requiredAccountId === this.lastAccountId) &&
      (this.wasProfileSelect || !doProfileSelect)
    );
  }

  async ensureAuthenticated(doProfileSelect: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      signal.throwIfAborted();
      if (this.isSatisfied(doProfileSelect)) {
        const probe = await this.pool.withConnection(signal, connection =>
          connection.request('setting.display', { payload: { screen: 'account' } }, signal));
        if (probe.status === 'Ok') return;
        this.pool.authenticate(null);
        this.lastAccountId = null;
        this.wasProfileSelect = false;
      }
      const authData = await this.pool.withConnection(signal, (connection) =>
        login(connection, this.credentials, this.requiredAccountId, doProfileSelect, signal),
      );
      this.pool.authenticate(authData.authToken);
      this.lastAccountId = authData.accountId;
      this.wasProfileSelect = doProfileSelect;
    } finally {
      release();
    }
  }
}


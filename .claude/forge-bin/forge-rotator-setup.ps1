<#
.SYNOPSIS
  forge-rotator-setup.ps1 - guided enrolment of Claude setup tokens into the Forge account rotator.
  Begeleide inschrijving van Claude setup-tokens in de Forge account-rotator.

.DESCRIPTION
  Run this YOURSELF in a normal PowerShell window (never from an AI agent):
      powershell -ExecutionPolicy Bypass -File .claude\forge-bin\forge-rotator-setup.ps1
  Per account it asks a name, lets you run `claude setup-token` in another window, reads the token HIDDEN
  (Read-Host -AsSecureString) and hands it to `node account-rotator.cjs enroll-token <name>` on STDIN only:
  never as an argument, never as an environment variable, never on screen, never on disk.
  At the end it runs `account-rotator.cjs status`, explains every line and prints the next commands.

  -SelfTest   checks the name rule, the refusal rules and a DRY enrolment against a FAKE rotator given by
              -RotatorPath (refuses the real account-rotator.cjs). Used by forge-rotator-setup.test.cjs.
#>
[CmdletBinding()]
param(
  [switch]$SelfTest,
  [string]$RotatorPath,
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'

$Script:DefaultRotator = Join-Path $PSScriptRoot 'account-rotator.cjs'
# Same markers as account-rotator-token.cjs AGENT_MARKERS: an AI agent's tool environment.
$Script:AgentMarkers = @('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED')
# Same rule as account-rotator-vault.cjs validName(): NAME_RE + RESERVED (case-insensitive).
$Script:NamePattern = '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}\z'
$Script:Reserved = @('state', 'handoff', 'rotator', 'txn', 'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9')

function Test-AccountName([string]$Name) {
  if ([string]::IsNullOrEmpty($Name)) { return $false }
  if ($Name -cnotmatch $Script:NamePattern) { return $false }
  return -not ($Script:Reserved -contains $Name.ToLowerInvariant())
}

# Returns $null (ok to run), 'agent:<MARKER>' or 'noninteractive'.
function Get-RefusalReason {
  param([hashtable]$EnvTable, [string[]]$CmdArgs, [bool]$InputRedirected, [bool]$UserInteractive)
  foreach ($k in $Script:AgentMarkers) {
    if ($EnvTable.ContainsKey($k) -and -not [string]::IsNullOrEmpty([string]$EnvTable[$k])) { return 'agent:' + $k }
  }
  if ((-not $UserInteractive) -or $InputRedirected) { return 'noninteractive' }
  foreach ($a in $CmdArgs) {
    if ($a -match '^[-/](file|f|command|c|encodedcommand|ec|e)$') { break } # what follows belongs to the script
    if ($a -match '^[-/]noni') { return 'noninteractive' }
  }
  return $null
}

function Get-CurrentEnvTable {
  $h = @{}
  foreach ($k in $Script:AgentMarkers) {
    $v = [Environment]::GetEnvironmentVariable($k)
    if (-not [string]::IsNullOrEmpty($v)) { $h[$k] = $v }
  }
  return $h
}

function Resolve-NodeExe([string]$Explicit) {
  if ($Explicit) {
    if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
    throw ('Node.js not found at ' + $Explicit)
  }
  $c = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $fallback) { return $fallback }
  throw 'Node.js not found - install it from https://nodejs.org / Node.js niet gevonden'
}

# Runs `node <rotator> <args>`. With -Secret the token goes to the child's STDIN only; the child's environment never
# carries FORGE_ROTATOR_ENROLL_TOKEN. The plain token exists only in memory for the duration of this call.
function Invoke-Rotator {
  param([string]$Node, [string]$Rotator, [string[]]$Arguments, [System.Security.SecureString]$Secret)
  $all = @($Rotator) + @($Arguments)
  foreach ($a in $all) { if ($a -match '"') { throw 'refusing an argument that contains a double quote' } }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = (($all | ForEach-Object { '"' + $_ + '"' }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  if ($psi.EnvironmentVariables.ContainsKey('FORGE_ROTATOR_ENROLL_TOKEN')) { $psi.EnvironmentVariables.Remove('FORGE_ROTATOR_ENROLL_TOKEN') }
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $plain = $null
  $bytes = $null
  $bstr = [IntPtr]::Zero
  try {
    if ($Secret -and $Secret.Length -gt 0) {
      # the ONE controlled SecureString -> plain conversion (in memory only)
      $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
      $plain = ([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)).Trim()
      $bytes = [System.Text.Encoding]::ASCII.GetBytes($plain + "`n")
      $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
      $proc.StandardInput.BaseStream.Flush()
    }
  } finally {
    if ($bstr -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length); $bytes = $null }
    try { $proc.StandardInput.Close() } catch { }
  }
  $proc.WaitForExit()
  $out = [string]$outTask.Result
  $err = [string]$errTask.Result
  if ($plain -and $plain.Length -ge 8) { $out = $out.Replace($plain, '[redacted]'); $err = $err.Replace($plain, '[redacted]') }
  $plain = $null
  return [pscustomobject]@{ ExitCode = $proc.ExitCode; Out = $out; Err = $err }
}

function Get-StatusExplanation([string]$Line) {
  $t = $Line.Trim()
  $warn = [string][char]0x26A0
  if ($t -like 'instellingen / settings:*') { return 'Your rotator settings: on/off, mode (token or file), threshold and interval. / Je instellingen.' }
  if ($t -like 'note:*') { return 'A remark from the rotator about your settings. / Een opmerking over je instellingen.' }
  if ($t -like 'watcher:*') { return 'Whether the background watcher runs; start it with the start command below. / Of de wachter draait.' }
  if ($t.StartsWith($warn)) { return 'A login token in this shell overrides the rotator for new sessions. / Een token in deze shell gaat voor.' }
  if ($t -like 'account-rotator staat uit*') { return 'The rotator is switched off, so only last-known numbers are shown. / De rotator staat uit.' }
  if ($t -like 'kill-switch*') { return 'The emergency stop is on; run `enable` to resume. / De noodstop staat aan.' }
  if ($t -like '(geen accounts*') { return 'No account is enrolled yet. / Nog geen account ingeschreven.' }
  if ($t -like 'beslissing nu*' -or $t -like 'zou nu*') { return 'What the rotator would do right now. / Wat de rotator nu zou doen.' }
  if ($t -like 'aanbeveling*') { return 'Which account the next session should use. / Welk account de volgende sessie moet gebruiken.' }
  if ($t -like 'wacht op verificatie*') { return 'A recent switch is still being checked. / Een recente wissel wordt nog gecontroleerd.' }
  if ($t -like 'laatste wissel*') { return 'The most recent account switch. / De laatste wissel.' }
  if ($t -like 'handoff:*') { return 'An account handover in progress or just finished. / Een overdracht die loopt of net klaar is.' }
  if ($Line -match '^\s{2}\S') { return 'One enrolled account: its name, masked e-mail or "token only", and whether it is usable, full or unknown. / Een ingeschreven account.' }
  return 'Extra information from the rotator. / Extra informatie.'
}

function Write-Both([string]$En, [string]$Nl) {
  Write-Host $En
  Write-Host ('  ' + $Nl) -ForegroundColor DarkGray
}

function Show-RotatorResult($Result) {
  foreach ($l in (($Result.Out + "`n" + $Result.Err) -split "`r?`n")) { if ($l.Trim()) { Write-Host ('  > ' + $l) } }
  if ($Result.ExitCode -eq 0) { Write-Both 'Enrolled.' 'Ingeschreven.' }
  else { Write-Both ('Not enrolled (rotator exit code ' + $Result.ExitCode + '); see the line above.') ('Niet ingeschreven (code ' + $Result.ExitCode + '); zie de regel hierboven.') }
}

function Read-AccountName {
  while ($true) {
    $n = Read-Host 'Account name (letters, digits, - and _, max 32; empty = stop) / Accountnaam (leeg = stoppen)'
    if ([string]::IsNullOrWhiteSpace($n)) { return $null }
    $n = $n.Trim()
    if (Test-AccountName $n) { return $n }
    Write-Both ('"' + $n + '" is not a valid name: start with a letter or digit, then letters, digits, - or _ (max 32), and not a reserved word like con or state.') 'Ongeldige naam: begin met een letter of cijfer, daarna letters, cijfers, - of _ (max 32), geen gereserveerd woord.'
  }
}

function Invoke-SelfTest {
  $ok = $true
  $result = [ordered]@{}
  $samples = @('alice', 'Work-1', 'a_b', '0x', '-bad', '_bad', '../x', 'con', 'CON', 'state', 'Lpt9', '', ('a' * 32), ('a' * 33), 'has space', "line`n", 'e.mail', 'Zoe_99')
  $result.names = @($samples | ForEach-Object { [ordered]@{ name = $_; valid = (Test-AccountName $_) } })
  $ref = [ordered]@{
    agent = Get-RefusalReason -EnvTable @{ CLAUDECODE = '1' } -CmdArgs @('powershell.exe') -InputRedirected $false -UserInteractive $true
    agentEmptyIgnored = Get-RefusalReason -EnvTable @{ CLAUDECODE = '' } -CmdArgs @('powershell.exe') -InputRedirected $false -UserInteractive $true
    nonInteractiveFlag = Get-RefusalReason -EnvTable @{} -CmdArgs @('powershell.exe', '-NoProfile', '-NonInteractive', '-File', 'x.ps1') -InputRedirected $false -UserInteractive $true
    redirectedInput = Get-RefusalReason -EnvTable @{} -CmdArgs @('powershell.exe') -InputRedirected $true -UserInteractive $true
    scriptArgNotCounted = Get-RefusalReason -EnvTable @{} -CmdArgs @('powershell.exe', '-File', 'x.ps1', '-NonInteractive') -InputRedirected $false -UserInteractive $true
    thisProcess = Get-RefusalReason -EnvTable (Get-CurrentEnvTable) -CmdArgs ([Environment]::GetCommandLineArgs()) -InputRedirected ([Console]::IsInputRedirected) -UserInteractive ([Environment]::UserInteractive)
  }
  $result.refusal = $ref
  if ($ref.agent -ne 'agent:CLAUDECODE' -or $ref.agentEmptyIgnored -ne $null -or $ref.nonInteractiveFlag -ne 'noninteractive' -or $ref.redirectedInput -ne 'noninteractive' -or $ref.scriptArgNotCounted -ne $null) { $ok = $false }
  $result.explain = @('instellingen / settings: x', 'watcher: niet actief / not running', '  alice  [token]') | ForEach-Object { Get-StatusExplanation $_ }

  $dry = [ordered]@{ ran = $false }
  if (-not $RotatorPath) { $dry.error = 'dry enrolment needs -RotatorPath <fake rotator>'; $ok = $false }
  else {
    $fakePath = (Resolve-Path -LiteralPath $RotatorPath).Path
    $realPath = [System.IO.Path]::GetFullPath($Script:DefaultRotator)
    if ([string]::Equals($fakePath, $realPath, [StringComparison]::OrdinalIgnoreCase)) { $dry.error = 'refused: -SelfTest never runs against the real account-rotator.cjs'; $ok = $false }
    else {
      $node = Resolve-NodeExe $NodePath
      $fake = 'sk-ant-oat01-SELFTEST-' + [guid]::NewGuid().ToString('N')
      $sec = New-Object System.Security.SecureString
      foreach ($ch in $fake.ToCharArray()) { $sec.AppendChar($ch) }
      $sec.MakeReadOnly()
      $r = Invoke-Rotator -Node $node -Rotator $fakePath -Arguments @('enroll-token', 'selftest-acct') -Secret $sec
      $sec.Dispose()
      $dry.ran = $true
      $dry.exitCode = $r.ExitCode
      $dry.out = $r.Out.Trim()
      $dry.tokenEchoed = ($r.Out.Contains($fake) -or $r.Err.Contains($fake))
      $fake = $null
      if ($r.ExitCode -ne 0 -or $dry.tokenEchoed) { $ok = $false }
    }
  }
  $result.dry = $dry
  $result.ok = $ok
  [Console]::Out.WriteLine('SELFTEST-JSON ' + (ConvertTo-Json -InputObject $result -Compress -Depth 6))
  if ($ok) { return 0 } else { return 1 }
}

# ---- entry ----------------------------------------------------------------------------------------------------
if ($SelfTest) { exit (Invoke-SelfTest) }

$reason = Get-RefusalReason -EnvTable (Get-CurrentEnvTable) -CmdArgs ([Environment]::GetCommandLineArgs()) -InputRedirected ([Console]::IsInputRedirected) -UserInteractive ([Environment]::UserInteractive)
if ($reason -like 'agent:*') {
  [Console]::Error.WriteLine('REFUSED: this wizard is for the owner in a normal PowerShell window, not for an AI agent (' + $reason.Substring(6) + ' is set). / GEWEIGERD: deze wizard is voor de eigenaar in een gewoon PowerShell-venster, niet voor een AI-agent.')
  exit 2
}
if ($reason) {
  [Console]::Error.WriteLine('REFUSED: this wizard needs an interactive PowerShell window (no -NonInteractive, no piped input). / GEWEIGERD: deze wizard heeft een interactief PowerShell-venster nodig.')
  exit 3
}

$rotator = if ($RotatorPath) { $RotatorPath } else { $Script:DefaultRotator }
if (-not (Test-Path -LiteralPath $rotator)) { [Console]::Error.WriteLine('account-rotator.cjs not found / niet gevonden: ' + $rotator); exit 1 }
$rotator = (Resolve-Path -LiteralPath $rotator).Path
$node = Resolve-NodeExe $NodePath

Write-Host ''
Write-Both 'Forge account rotator - setup wizard' 'Forge account-rotator - inschrijfwizard'
Write-Both 'What happens: for each Claude account you give a name, create a token with `claude setup-token`, and paste it here.' 'Wat er gebeurt: per Claude-account geef je een naam, maak je een token met `claude setup-token` en plak je het hier.'
Write-Both 'Your token is NEVER shown, logged, saved by this script or put in your history; it goes straight to the rotator (stdin).' 'Je token wordt NOOIT getoond, gelogd, door dit script opgeslagen of in je geschiedenis gezet; het gaat rechtstreeks naar de rotator.'
Write-Host ''

$again = 'y'
while ($again -match '^(y|yes|j|ja)$') {
  $name = Read-AccountName
  if (-not $name) { break }
  Write-Both ('Now open ANOTHER PowerShell window and run:  claude setup-token   - sign in as the account you call "' + $name + '" and copy the token it prints.') ('Open nu een ANDER PowerShell-venster en voer uit:  claude setup-token   - log in met het account "' + $name + '" en kopieer het getoonde token.')
  $sec = Read-Host -AsSecureString -Prompt 'Paste the token (hidden; empty = skip) / Plak het token (onzichtbaar; leeg = overslaan)'
  if ($null -eq $sec -or $sec.Length -eq 0) {
    Write-Both 'No token entered - skipped.' 'Geen token ingevoerd - overgeslagen.'
  } else {
    $r = Invoke-Rotator -Node $node -Rotator $rotator -Arguments @('enroll-token', $name) -Secret $sec
    $sec.Dispose()
    $sec = $null
    Show-RotatorResult $r
  }
  $again = ([string](Read-Host 'Enrol another account? (y/n) / Nog een account inschrijven? (j/n)')).Trim().ToLowerInvariant()
}

Write-Host ''
Write-Both 'Current rotator status - each line explained:' 'Huidige status van de rotator - elke regel uitgelegd:'
$st = Invoke-Rotator -Node $node -Rotator $rotator -Arguments @('status')
foreach ($l in (($st.Out + "`n" + $st.Err) -split "`r?`n")) {
  if (-not $l.Trim()) { continue }
  Write-Host ('  ' + $l)
  Write-Host ('      -> ' + (Get-StatusExplanation $l)) -ForegroundColor DarkGray
}
Write-Host ''
Write-Both 'Next steps (token mode needs at least two enrolled tokens and the rotator switched on: /forge config set account-rotator aan):' 'Volgende stappen (token-modus heeft minstens twee tokens nodig en de rotator moet aan staan):'
Write-Host ('  node "' + $rotator + '" start')
Write-Both '      starts the background watcher.' 'start de wachter op de achtergrond.'
Write-Host ('  node "' + $rotator + '" launch --auto -- <claude args>')
Write-Both '      starts a NEW Claude Code session on the best account.' 'start een NIEUWE Claude Code-sessie op het beste account.'
exit 0

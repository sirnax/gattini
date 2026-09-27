declare module "vscode" {
  export interface Disposable { dispose(): void }
  export interface Memento { get<T>(key: string, defaultValue: T): T; update(key: string, value: unknown): Thenable<void> }
  export interface ExtensionContext { workspaceState: Memento; subscriptions: Disposable[] }
  export interface Uri { fsPath: string; toString(): string }
  export interface WorkspaceFolder { uri: Uri; name: string }
  export interface QuickPickItem { label: string; description?: string; detail?: string }
  export interface OutputChannel { appendLine(value: string): void; show(preserveFocus?: boolean): void; dispose(): void }
  export namespace workspace {
    let isTrusted: boolean;
    let workspaceFolders: readonly WorkspaceFolder[] | undefined;
    function onDidGrantWorkspaceTrust(listener: () => void): Disposable;
  }
  export namespace window {
    function showErrorMessage(message: string): Thenable<string | undefined>;
    function showInformationMessage(message: string): Thenable<string | undefined>;
    function showWarningMessage(message: string): Thenable<string | undefined>;
    function showWarningMessage(message: string, options: { modal: boolean }, ...items: string[]): Thenable<string | undefined>;
    function showInputBox(options?: { prompt?: string; ignoreFocusOut?: boolean }): Thenable<string | undefined>;
    function showQuickPick<T extends QuickPickItem>(items: readonly T[], options?: { placeHolder?: string }): Thenable<T | undefined>;
    function createOutputChannel(name: string): OutputChannel;
  }
  export namespace commands { function registerCommand(command: string, callback: () => unknown): Disposable }
}

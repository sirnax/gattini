const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');

exports.run = async function run() {
  const vscode = require('vscode');
  const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'gattini-vscode');
  assert(extension, 'Gattini extension is loaded in the disposable extension host');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['gattini.submitTask', 'gattini.attachJob', 'gattini.showJobs', 'gattini.showResult', 'gattini.showEvidence',
    'gattini.approve', 'gattini.deny', 'gattini.cancel']) assert(commands.includes(command), `${command} is registered`);
  await vscode.commands.executeCommand('gattini.showJobs');
  if (process.env.GATTINI_HOST_TEST_MARKER) writeFileSync(process.env.GATTINI_HOST_TEST_MARKER, 'registered and executed gattini.showJobs\n');
};

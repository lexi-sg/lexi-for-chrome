// src/bridge/ask.js
//
// The ask window (src/background/bridge-ask.js opens it): Lexi chat wants to
// use a site, or to do something Agent Mode would confirm. Everything shown
// comes from the query string and goes in as text, never HTML: an element's
// name is the website's text.

import { MSG } from '../config.js';

const params = new URLSearchParams(location.search);
const id = params.get('id') || '';
const $ = (elementId) => document.getElementById(elementId);

function answer(value) {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  chrome.runtime.sendMessage({ type: MSG.BRIDGE_ASK_ANSWER, id, answer: value }).finally(() => window.close());
}

if (params.get('kind') === 'site') {
  const hosts = (params.get('hosts') || '').split(',').filter(Boolean);
  $('question').textContent = `Lexi chat wants to use ${hosts.join(', ')} in this browser`;
  $('about').textContent =
    'It works in a background tab in the “Lexi” tab group, signed in as you are on that site. ' +
    'It never types passwords, and asks again before it submits, sends, pays, uploads, downloads ' +
    'or deletes anything. Close the tab to stop it.';
  $('allow').textContent = 'Allow for this task';
  $('always').hidden = false;
} else {
  $('question').textContent = `Lexi chat wants to ${params.get('action') || 'do this'} on ${params.get('host') || 'this site'}`;
  const element = params.get('element');
  if (element) {
    $('element').textContent = `On: “${element}”`;
    $('element').hidden = false;
  }
  const typed = params.get('text');
  if (typed) {
    $('typed').textContent = `Text: “${typed}”`;
    $('typed').hidden = false;
  }
  $('about').textContent = 'Check the Lexi tab before you allow it. Nothing happens if you don’t answer.';
}

$('allow').addEventListener('click', () => answer('once'));
$('always').addEventListener('click', () => answer('always'));
$('deny').addEventListener('click', () => answer('no'));
document.title = $('question').textContent;

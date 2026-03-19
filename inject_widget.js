const fs = require('fs');
const path = require('path');

const root = 'C:/Users/ethan/NewSparkyStudy';
const skip = new Set(['index.html','index_backup.html','index_new.html','login.html','onboarding.html','payment.html','pricing.html','refund.html','terms.html']);

function walk(dir) {
  const entries = fs.readdirSync(dir, {withFileTypes: true});
  let files = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files = files.concat(walk(full));
    else if (e.name.endsWith('.html')) files.push(full);
  }
  return files;
}

const files = walk(root);
let count = 0;

for (const fpath of files) {
  const fname = path.basename(fpath);
  if (skip.has(fname)) continue;

  let content = fs.readFileSync(fpath, 'utf8');
  if (content.includes('sparkstudy-ai-widget') || !content.includes('</body>')) continue;

  const rel = path.relative(path.dirname(fpath), root).split(path.sep).join('/');
  const widgetSrc = rel ? rel + '/sparkstudy-ai-widget.js' : 'sparkstudy-ai-widget.js';

  const inject = [
    '',
    '<!-- SparkStudy AI Widget -->',
    '<script>',
    '(function(){',
    '  var btn = document.createElement("button");',
    '  btn.id = "askaiBtn";',
    '  btn.title = "Ask SparkStudy AI";',
    '  btn.innerHTML = "&#9889;";',
    '  btn.style.cssText = "position:fixed;bottom:24px;left:24px;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#f97316,#ea580c);border:none;color:#fff;font-size:1.5rem;cursor:pointer;z-index:9997;box-shadow:0 4px 20px rgba(249,115,22,0.5);transition:transform 0.15s;";',
    '  btn.onmouseover = function(){ this.style.transform="scale(1.1)"; };',
    '  btn.onmouseout  = function(){ this.style.transform="scale(1)"; };',
    '  document.body.appendChild(btn);',
    '})();',
    '</script>',
    '<script src="' + widgetSrc + '" defer></script>',
    '</body>'
  ].join('\n');

  content = content.replace('</body>', inject);
  fs.writeFileSync(fpath, content, 'utf8');
  count++;
  console.log('  ok ' + fpath.replace(root, ''));
}

console.log('\nDone — ' + count + ' pages updated');

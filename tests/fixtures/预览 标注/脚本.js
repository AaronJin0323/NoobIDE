// The page counts its own button clicks and every DOM change, so the e2e test can prove that picking an element
// neither clicks it nor changes the page.
window.clicks = 0;
window.mutations = 0;
document.getElementById('send').addEventListener('click', () => {
  window.clicks += 1;
});
const extra = document.createElement('li');
extra.textContent = '橙子（脚本加的）';
document.getElementById('list').appendChild(extra);
new MutationObserver((records) => {
  window.mutations += records.length;
}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

// What the page itself is told about errors: for a script from another website only "Script error.".
window.addEventListener('error', (event) => {
  document.body.dataset.pageSaw = event.message;
});

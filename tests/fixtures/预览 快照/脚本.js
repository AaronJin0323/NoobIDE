// S38.2 fixture: the "Send" button does nothing because of a typo (the agent reads this error in get_console).
document.getElementById('send').addEventListener('click', () => {
  sendMesage();
});
document.getElementById('send').click();

// 用模板字符串生成一张卡片
function renderCard(user) {
    const html = `
  <div class="card">
     <h2>${user.name}</h2>
   <p>
         年龄：${user.age}
   </p>
  </div>
`;
    return html;
}

function renderList(users) {
    const items = users.map((u) => {
        return `<li>
  ${u.name}
       </li>`;
    });
    if (items.length === 0) {
        return '<p>没有用户</p>';
    }
    return items.join('');
}

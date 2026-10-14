// script.js 是"交互行为"：让网页动起来（比如点击按钮后发生什么）。

const likeButton = document.querySelector('#like-button');
const likeStatus = document.querySelector('#like-status');

// 记录现在有没有加入心愿单
let isLiked = false;

likeButton.addEventListener('click', function () {
  // 每点一次，就在"加入"和"取消"之间切换
  isLiked = !isLiked;

  if (isLiked) {
    likeButton.textContent = '已加入心愿单';
    likeStatus.textContent = '好眼光！它已经在你的心愿单里了。';
  } else {
    likeButton.textContent = '加入心愿单';
    likeStatus.textContent = '还没有加入心愿单。';
  }

  // 给按钮加上或去掉 liked 样式（样式写在 style.css 里）
  likeButton.classList.toggle('liked', isLiked);
});

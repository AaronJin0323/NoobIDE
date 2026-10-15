// 没有 catch 的 Promise 拒绝
function 加载数据() {
  return Promise.reject(new Error('数据加载失败'));
}
加载数据();

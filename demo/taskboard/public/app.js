import {fetchTasks} from './api.js';

const list = document.getElementById('tasks');

async function render() {
  const tasks = await fetchTasks();
  list.replaceChildren(...tasks.map(task => {
    const item = document.createElement('li');
    item.innerHTML = `<span class="title"></span><span class="assignee"></span>`;
    item.querySelector('.title').textContent = task.title;
    item.querySelector('.assignee').textContent = task.assignee;
    // TODO(frontend): task editor (title, assignee, save).
    return item;
  }));
}

render();

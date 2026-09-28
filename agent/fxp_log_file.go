package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

/*
FXP 子进程的标准输出/错误改接到日志文件。

以前 cmd.Stdout/Stderr 是 Go 的 io.Writer，os/exec 会为它建一根管道、由 Agent 里的协程读。
Agent 的 systemd 单元是 KillMode=process，Agent 重启时 FXP 故意留着继续转发 —— 但管道读端随旧
Agent 一起没了，FXP 下一次写日志就收到 SIGPIPE 退出，转发随之中断。

现在直接把一个 O_APPEND 打开的 *os.File 交给子进程（不经过管道），Agent 在不在都不影响 FXP 写日志。
文件放在 Agent 日志目录下（*.log），由现有的日志维护统一做大小上限与保留期裁剪（原地截断，
不换 inode，FXP 持有的描述符继续有效）。Agent 另外轮询这个文件的新增内容，照旧喂给 fxpLogWriter：
端点健康事件、启动失败原因、以及转写到 Agent 主日志，这些行为都保持不变。
*/

const fxpLogTailPollInterval = time.Second

// fxpLogTailMaxRead 限制单次轮询读取的字节数，FXP 自己也按每分钟 64KB 限速。
const fxpLogTailMaxRead = 256 * 1024

// fxpRuntimeLogPath 由配置文件路径派生：每个 FXP 进程一份，Agent 重启后接管进程时也能找回。
func fxpRuntimeLogPath(configPath string) string {
	base := strings.TrimSuffix(filepath.Base(configPath), filepath.Ext(configPath))
	if base == "" || base == "." {
		base = "fxp-runtime"
	}
	return filepath.Join(agentLogDir, base+".log")
}

// openFXPRuntimeLogFile 打开（必要时创建）给子进程用的日志文件，返回打开前的大小作为读取起点。
func openFXPRuntimeLogFile(path string) (*os.File, int64, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, 0, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return nil, 0, err
	}
	offset := int64(0)
	if info, err := file.Stat(); err == nil {
		offset = info.Size()
	}
	return file, offset, nil
}

// fxpLogTail 增量读取 FXP 日志文件并转交给 writer。
type fxpLogTail struct {
	mu      sync.Mutex
	path    string
	offset  int64
	partial []byte
	writer  func() io.Writer
}

func newFXPLogTail(path string, offset int64, writer func() io.Writer) *fxpLogTail {
	return &fxpLogTail{path: path, offset: offset, writer: writer}
}

// poll 读出自上次以来追加的完整行。文件被日志维护截短时从新的末尾继续（中间那段已被裁掉）。
func (t *fxpLogTail) poll() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	file, err := os.Open(t.path)
	if err != nil {
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return
	}
	size := info.Size()
	if size < t.offset {
		t.offset = size
		t.partial = nil
		return
	}
	if size == t.offset {
		return
	}
	toRead := size - t.offset
	if toRead > fxpLogTailMaxRead {
		// 积压太多（比如 Agent 刚接管）就只看最近的一段。
		t.offset = size - fxpLogTailMaxRead
		t.partial = nil
		toRead = fxpLogTailMaxRead
	}
	buf := make([]byte, toRead)
	n, err := file.ReadAt(buf, t.offset)
	if err != nil && err != io.EOF {
		return
	}
	t.offset += int64(n)
	data := append(t.partial, buf[:n]...)
	t.partial = nil
	last := strings.LastIndexByte(string(data), '\n')
	if last < 0 {
		if len(data) < fxpLogMaxPartialBytes {
			t.partial = data
			return
		}
		last = len(data) - 1
	} else if last+1 < len(data) {
		t.partial = append([]byte(nil), data[last+1:]...)
	}
	if writer := t.writer(); writer != nil {
		_, _ = writer.Write(data[:last+1])
	}
}

// fxpLogMaxPartialBytes：一行一直没有换行符时最多攒这么多再强制交出去。
const fxpLogMaxPartialBytes = 16 * 1024

// run 在 stop 关闭前定期轮询，关闭后再读最后一次。
func (t *fxpLogTail) run(stop <-chan struct{}) {
	ticker := time.NewTicker(fxpLogTailPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			t.poll()
			return
		case <-ticker.C:
			t.poll()
		}
	}
}

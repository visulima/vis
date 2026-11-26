//! A terminal for `stdin: "pty"` on macOS that opens in microseconds.
//!
//! `portable-pty`'s `openpty` also looks up the name of the slave with `ttyname_r`, which on macOS
//! walks `/dev` entry by entry: 1 to 3 ms per terminal, on the one thread that starts commands.
//! `posix_spawn` needs that name, and `ptsname` finds it with one `ioctl`. This module opens the
//! terminal with `openpty(3)`, reads the name that way, and hands the master to the rest of the pty
//! code as a `portable_pty::MasterPty`, so nothing else has to know which of the two made it.
//! Reads, the size, the writer and its end-of-file on drop behave like `portable-pty`'s.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use nix::libc;
use portable_pty::{MasterPty, PtySize};

/// The master side of a terminal opened by [`open`].
pub(crate) struct Master {
    fd: OwnedFd,
    name: PathBuf,
    took_writer: AtomicBool,
}

/// Open a terminal of `size`: the master, the slave (to be closed once the command holds its own
/// end), and the slave's name.
pub(crate) fn open(size: PtySize) -> io::Result<(Master, OwnedFd, PathBuf)> {
    let mut master: libc::c_int = 0;
    let mut slave: libc::c_int = 0;
    let mut window = window_size(size);

    // SAFETY: both out-pointers are valid for a `c_int`; no name or termios is asked for or given.
    let opened = unsafe {
        libc::openpty(&raw mut master, &raw mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &raw mut window)
    };

    if opened != 0 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: `openpty` just created both descriptors and nothing else owns them.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };

    // Closed in a child that is started any other way than by `posix_spawn`.
    close_on_exec(master.as_raw_fd())?;
    close_on_exec(slave.as_raw_fd())?;

    let name = slave_name(master.as_raw_fd())?;

    Ok((Master { fd: master, name: name.clone(), took_writer: AtomicBool::new(false) }, slave, name))
}

fn close_on_exec(fd: RawFd) -> io::Result<()> {
    // SAFETY: `fd` is an open descriptor; both commands take an int.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };

    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }

    Ok(())
}

/// The path of the slave of the terminal whose master is `master` (`TIOCPTYGNAME`: one `ioctl`).
fn slave_name(master: RawFd) -> io::Result<PathBuf> {
    let mut buffer = [0 as libc::c_char; 128];

    // SAFETY: `TIOCPTYGNAME` writes a NUL-terminated name of at most 128 bytes into the buffer.
    if unsafe { libc::ioctl(master, libc::TIOCPTYGNAME as _, buffer.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: the kernel wrote a NUL-terminated string.
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }.to_bytes())))
}

fn window_size(size: PtySize) -> libc::winsize {
    libc::winsize { ws_row: size.rows, ws_col: size.cols, ws_xpixel: size.pixel_width, ws_ypixel: size.pixel_height }
}

impl Master {
    fn duplicate(&self) -> io::Result<File> {
        Ok(File::from(self.fd.try_clone()?))
    }
}

impl MasterPty for Master {
    fn resize(&self, size: PtySize) -> Result<(), anyhow::Error> {
        let window = window_size(size);

        // SAFETY: the descriptor is open and `TIOCSWINSZ` reads a `winsize`.
        if unsafe { libc::ioctl(self.fd.as_raw_fd(), libc::TIOCSWINSZ as _, &raw const window) } != 0 {
            anyhow::bail!("failed to ioctl(TIOCSWINSZ): {:?}", io::Error::last_os_error());
        }

        Ok(())
    }

    fn get_size(&self) -> Result<PtySize, anyhow::Error> {
        let mut window: libc::winsize = unsafe { std::mem::zeroed() };

        // SAFETY: the descriptor is open and `TIOCGWINSZ` writes a `winsize`.
        if unsafe { libc::ioctl(self.fd.as_raw_fd(), libc::TIOCGWINSZ as _, &raw mut window) } != 0 {
            anyhow::bail!("failed to ioctl(TIOCGWINSZ): {:?}", io::Error::last_os_error());
        }

        Ok(PtySize {
            rows: window.ws_row,
            cols: window.ws_col,
            pixel_width: window.ws_xpixel,
            pixel_height: window.ws_ypixel,
        })
    }

    fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>, anyhow::Error> {
        Ok(Box::new(Reader(self.duplicate()?)))
    }

    fn take_writer(&self) -> Result<Box<dyn Write + Send>, anyhow::Error> {
        if self.took_writer.swap(true, Ordering::AcqRel) {
            anyhow::bail!("cannot take writer more than once");
        }

        Ok(Box::new(Writer(self.duplicate()?)))
    }

    fn process_group_leader(&self) -> Option<libc::pid_t> {
        // SAFETY: the descriptor is open.
        match unsafe { libc::tcgetpgrp(self.fd.as_raw_fd()) } {
            pid if pid > 0 => Some(pid),
            _ => None,
        }
    }

    fn as_raw_fd(&self) -> Option<RawFd> {
        Some(self.fd.as_raw_fd())
    }

    fn tty_name(&self) -> Option<PathBuf> {
        Some(self.name.clone())
    }
}

/// Reads the terminal's output. EIO is how the master learns that the last slave closed: that is
/// the end of the output, as it is for `portable-pty`.
struct Reader(File);

impl Read for Reader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self.0.read(buffer) {
            Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(0),
            other => other,
        }
    }
}

/// Writes to the terminal's input. Dropping it types an end-of-file, as `portable-pty`'s writer does.
struct Writer(File);

impl Write for Writer {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        let mut termios: libc::termios = unsafe { std::mem::zeroed() };

        // SAFETY: the descriptor is open and `tcgetattr` fills in a `termios`.
        if unsafe { libc::tcgetattr(self.0.as_raw_fd(), &raw mut termios) } == 0 {
            // End-of-file is only seen after a newline, so a newline goes first.
            let eof = termios.c_cc[libc::VEOF];

            if eof != 0 {
                let _ = self.0.write_all(&[b'\n', eof]);
            }
        }
    }
}

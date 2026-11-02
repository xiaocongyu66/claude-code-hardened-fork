use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeId {
    session: u64,
    slot: usize,
    generation: u32,
}

impl NodeId {
    pub fn parts(self) -> (u64, usize, u32) {
        (self.session, self.slot, self.generation)
    }
}

#[derive(Clone, Copy, Debug)]
pub enum NodeRef {
    Id(NodeId),
    Temp(u32),
}

#[derive(Clone, Copy, Debug)]
pub enum NodeSpec<'a> {
    Box,
    Text(&'a str),
}

#[derive(Clone, Copy, Debug)]
pub enum Op<'a> {
    Create {
        temp: u32,
        parent: NodeRef,
        kind: NodeSpec<'a>,
    },
    UpdateText {
        node: NodeRef,
        text: &'a str,
    },
    Reparent {
        node: NodeRef,
        parent: NodeRef,
    },
    Delete {
        node: NodeRef,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Box,
    Text(Rc<str>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub kind: Kind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    Closed,
    Revision,
    Id,
    Ref,
    Tree,
    Limit,
    Exhausted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error {
    pub code: ErrorCode,
    pub op_index: Option<usize>,
}

impl From<ErrorCode> for Error {
    fn from(code: ErrorCode) -> Self {
        Self {
            code,
            op_index: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// 包括永久根、空闲槽和 generation 耗尽的退役槽。
    pub slots: usize,
    pub ops: usize,
    pub text_bytes: usize,
    pub live_text_bytes: usize,
    /// 每次 Create/UpdateText 输入都累计，包括随后被覆盖或删除的文本。
    pub batch_text_bytes: usize,
    /// 验证节点访问、兄弟扫描及 children 克隆/可能搬移的估算预算。
    /// 不含 arena/free reserve 搬移、BTreeMap 操作、commit/drop；不是全部工作或真实拷贝数。
    pub visits: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            slots: 4096,
            ops: 256,
            text_bytes: 64 * 1024,
            live_text_bytes: 1024 * 1024,
            batch_text_bytes: 256 * 1024,
            visits: 65536,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stats {
    pub root: NodeId,
    pub revision: u32,
    pub closed: bool,
    pub slots: usize,
    pub free_slots: usize,
    pub retired_slots: usize,
    pub live_nodes: usize,
    pub live_text_bytes: usize,
    /// 最后一次非空成功提交的 visits（口径见 Limits::visits）；空批和失败不覆盖，close 清零。
    pub last_batch_visits: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Applied {
    pub revision: u32,
    /// 按 temp 数值排序；同批创建后删除的 ID 也返回，但已失效。
    pub created: Vec<(u32, NodeId)>,
    /// 本次提交的预算计数，口径见 Limits::visits；空批为零。
    pub visits: usize,
}

#[derive(Clone)]
struct Node {
    parent: Option<NodeId>,
    children: Vec<NodeId>,
    kind: Kind,
}

impl Node {
    fn bytes(&self) -> usize {
        match &self.kind {
            Kind::Box => 0,
            Kind::Text(text) => text.len(),
        }
    }
}

struct Slot {
    generation: u32,
    node: Option<Node>,
}

pub struct Session {
    limits: Limits,
    arena: Vec<Slot>,
    free: Vec<usize>,
    stats: Stats,
}

impl Session {
    pub fn new(limits: Limits) -> Result<Self, Error> {
        let hard = Limits::default();
        if limits.slots == 0
            || limits.slots > hard.slots
            || limits.ops > hard.ops
            || limits.text_bytes > hard.text_bytes
            || limits.live_text_bytes > hard.live_text_bytes
            || limits.batch_text_bytes > hard.batch_text_bytes
            || limits.visits > hard.visits
        {
            return Err(ErrorCode::Limit.into());
        }
        // MAX 永久作为耗尽哨兵，跨线程创建也不重复；Session 本身因 Rc 为 !Send。
        let session = next_session(&NEXT_SESSION)?;
        let root = NodeId {
            session,
            slot: 0,
            generation: 0,
        };
        Ok(Self {
            limits,
            arena: vec![Slot {
                generation: 0,
                node: Some(Node {
                    parent: None,
                    children: Vec::new(),
                    kind: Kind::Box,
                }),
            }],
            free: Vec::new(),
            stats: Stats {
                root,
                revision: 0,
                closed: false,
                slots: 1,
                free_slots: 0,
                retired_slots: 0,
                live_nodes: 1,
                live_text_bytes: 0,
                last_batch_visits: 0,
            },
        })
    }

    /// 仅恢复当前 session 中仍存活的 ID；事务仍需再次验证。
    pub fn node_id_from_parts(
        &self,
        session: u64,
        slot: usize,
        generation: u32,
    ) -> Result<NodeId, Error> {
        self.open()?;
        if session != self.stats.root.session
            || !self
                .arena
                .get(slot)
                .is_some_and(|entry| entry.generation == generation && entry.node.is_some())
        {
            return Err(ErrorCode::Id.into());
        }
        Ok(NodeId {
            session,
            slot,
            generation,
        })
    }

    pub fn stats(&self) -> Stats {
        self.stats.clone()
    }

    /// 释放 session 持有的全部存储；调用方保留的 Rc 快照不计入活文本预算。
    pub fn close(&mut self) {
        self.arena = Vec::new();
        self.free = Vec::new();
        self.stats.closed = true;
        self.stats.slots = 0;
        self.stats.free_slots = 0;
        self.stats.retired_slots = 0;
        self.stats.live_nodes = 0;
        self.stats.live_text_bytes = 0;
        self.stats.last_batch_visits = 0;
    }

    fn open(&self) -> Result<(), Error> {
        if self.stats.closed {
            Err(ErrorCode::Closed.into())
        } else {
            Ok(())
        }
    }

    /// 按请求顺序返回快照，children 按树内兄弟顺序；也受访问预算约束。
    pub fn inspect(&self, ids: &[NodeId]) -> Result<Vec<Snapshot>, Error> {
        self.open()?;
        if ids.len() > self.limits.slots {
            return Err(ErrorCode::Limit.into());
        }
        let mut tx = Transaction::new(self);
        ids.iter()
            .map(|&id| {
                let node = tx.copy(id)?;
                Ok(Snapshot {
                    id,
                    parent: node.parent,
                    children: node.children,
                    kind: node.kind,
                })
            })
            .collect::<Result<_, ErrorCode>>()
            .map_err(Into::into)
    }

    pub fn apply_batch(
        &mut self,
        expected_revision: u32,
        ops: &[Op<'_>],
    ) -> Result<Applied, Error> {
        self.open()?;
        if expected_revision != self.stats.revision {
            return Err(ErrorCode::Revision.into());
        }
        if ops.len() > self.limits.ops {
            return Err(ErrorCode::Limit.into());
        }
        if ops.is_empty() {
            return Ok(Applied {
                revision: expected_revision,
                created: Vec::new(),
                visits: 0,
            });
        }
        let revision = expected_revision
            .checked_add(1)
            .ok_or(ErrorCode::Exhausted)?;
        let mut tx = Transaction::new(self);
        for (index, op) in ops.iter().enumerate() {
            tx.apply(*op).map_err(|code| Error {
                code,
                op_index: Some(index),
            })?;
        }
        let created = tx.temps.iter().map(|(&temp, &id)| (temp, id)).collect();
        let Transaction {
            overlay,
            reused,
            appended,
            live,
            bytes,
            visits,
            ..
        } = tx;
        // 校验和结果分配已完成；发布前准备所有 Vec 容量。不把 OOM 伪装成可恢复错误。
        self.arena.reserve(appended);
        self.free.reserve(overlay.len());
        self.free.truncate(self.free.len() - reused);
        for _ in 0..appended {
            self.arena.push(Slot {
                generation: 0,
                node: None,
            });
        }
        for (index, node) in overlay {
            let slot = &mut self.arena[index];
            slot.node = node;
            if slot.node.is_none() {
                if let Some(generation) = slot.generation.checked_add(1) {
                    slot.generation = generation;
                    self.free.push(index);
                } else {
                    self.stats.retired_slots += 1;
                }
            }
        }
        self.stats.revision = revision;
        self.stats.slots = self.arena.len();
        self.stats.free_slots = self.free.len();
        self.stats.live_nodes = live;
        self.stats.live_text_bytes = bytes;
        self.stats.last_batch_visits = visits;
        Ok(Applied {
            revision,
            created,
            visits,
        })
    }
}

fn next_session(counter: &AtomicU64) -> Result<u64, ErrorCode> {
    counter
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| ErrorCode::Exhausted)
}

struct Transaction<'a> {
    session: &'a Session,
    overlay: BTreeMap<usize, Option<Node>>,
    temps: BTreeMap<u32, NodeId>,
    reused: usize,
    appended: usize,
    live: usize,
    bytes: usize,
    input_bytes: usize,
    visits: usize,
}

impl<'a> Transaction<'a> {
    fn new(session: &'a Session) -> Self {
        Self {
            session,
            overlay: BTreeMap::new(),
            temps: BTreeMap::new(),
            reused: 0,
            appended: 0,
            live: session.stats.live_nodes,
            bytes: session.stats.live_text_bytes,
            input_bytes: 0,
            visits: 0,
        }
    }

    fn charge(&mut self, amount: usize) -> Result<(), ErrorCode> {
        if amount > self.session.limits.visits - self.visits {
            return Err(ErrorCode::Limit);
        }
        self.visits += amount;
        Ok(())
    }

    fn get(&mut self, id: NodeId) -> Result<&Node, ErrorCode> {
        self.charge(1)?;
        if id.session != self.session.stats.root.session {
            return Err(ErrorCode::Id);
        }
        let generation = self.session.arena.get(id.slot).map_or(0, |s| s.generation);
        if id.generation != generation {
            return Err(ErrorCode::Id);
        }
        if let Some(node) = self.overlay.get(&id.slot) {
            return node.as_ref().ok_or(ErrorCode::Id);
        }
        self.session
            .arena
            .get(id.slot)
            .and_then(|s| s.node.as_ref())
            .ok_or(ErrorCode::Id)
    }

    fn copy(&mut self, id: NodeId) -> Result<Node, ErrorCode> {
        let count = self.get(id)?.children.len();
        // 预收 children 克隆及随后追加可能触发的搬移；不扫描文本内容。
        self.charge(count * 2)?;
        Ok(self.get(id)?.clone())
    }

    fn resolve(&mut self, reference: NodeRef) -> Result<NodeId, ErrorCode> {
        let id = match reference {
            NodeRef::Id(id) => id,
            NodeRef::Temp(temp) => *self.temps.get(&temp).ok_or(ErrorCode::Ref)?,
        };
        self.get(id)?;
        Ok(id)
    }

    fn text(&mut self, text: &str, old: usize) -> Result<Kind, ErrorCode> {
        let limits = self.session.limits;
        // 输入为 Rust str，天然是合法 UTF-8；这里的长度只表示字节，不表示列宽。
        if text.len() > limits.text_bytes || text.len() > limits.batch_text_bytes - self.input_bytes
        {
            return Err(ErrorCode::Limit);
        }
        self.input_bytes += text.len();
        let bytes = self.bytes - old + text.len();
        if bytes > limits.live_text_bytes {
            return Err(ErrorCode::Limit);
        }
        self.bytes = bytes;
        Ok(Kind::Text(Rc::from(text)))
    }

    fn parent(&mut self, id: NodeId) -> Result<Node, ErrorCode> {
        if self.get(id)?.kind != Kind::Box {
            return Err(ErrorCode::Tree);
        }
        self.copy(id)
    }

    fn unlink(&mut self, parent: NodeId, child: NodeId) -> Result<(), ErrorCode> {
        let mut node = self.copy(parent)?;
        // retain 的全部兄弟扫描都收费，且保留其它节点的相对顺序。
        self.charge(node.children.len())?;
        node.children.retain(|&id| id != child);
        self.overlay.insert(parent.slot, Some(node));
        Ok(())
    }

    fn apply(&mut self, op: Op<'_>) -> Result<(), ErrorCode> {
        match op {
            Op::Create { temp, parent, kind } => {
                if self.temps.contains_key(&temp) {
                    return Err(ErrorCode::Ref);
                }
                let parent = self.resolve(parent)?;
                let mut owner = self.parent(parent)?;
                let kind = match kind {
                    NodeSpec::Box => Kind::Box,
                    NodeSpec::Text(text) => self.text(text, 0)?,
                };
                // 仅消耗批前空闲表；同批墓碑绝不进入候选槽。
                let slot = if self.reused < self.session.free.len() {
                    self.reused += 1;
                    self.session.free[self.session.free.len() - self.reused]
                } else {
                    let slot = self.session.arena.len() + self.appended;
                    if slot >= self.session.limits.slots {
                        return Err(ErrorCode::Limit);
                    }
                    self.appended += 1;
                    slot
                };
                let generation = self.session.arena.get(slot).map_or(0, |s| s.generation);
                let id = NodeId {
                    session: parent.session,
                    slot,
                    generation,
                };
                owner.children.push(id);
                self.overlay.insert(parent.slot, Some(owner));
                self.overlay.insert(
                    slot,
                    Some(Node {
                        parent: Some(parent),
                        children: Vec::new(),
                        kind,
                    }),
                );
                self.temps.insert(temp, id);
                self.live += 1;
            }
            Op::UpdateText { node, text } => {
                let id = self.resolve(node)?;
                let mut node = self.copy(id)?;
                if node.kind == Kind::Box {
                    return Err(ErrorCode::Tree);
                }
                node.kind = self.text(text, node.bytes())?;
                self.overlay.insert(id.slot, Some(node));
            }
            Op::Reparent { node, parent } => {
                let id = self.resolve(node)?;
                let parent = self.resolve(parent)?;
                let mut node = self.copy(id)?;
                let old = node.parent.ok_or(ErrorCode::Tree)?;
                let mut owner = self.parent(parent)?;
                let mut ancestor = Some(parent);
                while let Some(next) = ancestor {
                    if next == id {
                        return Err(ErrorCode::Tree);
                    }
                    ancestor = self.get(next)?.parent;
                }
                // 同父重挂保持原位置；其它重挂追加至新父尾部。
                if old != parent {
                    self.unlink(old, id)?;
                    owner.children.push(id);
                    node.parent = Some(parent);
                    self.overlay.insert(parent.slot, Some(owner));
                    self.overlay.insert(id.slot, Some(node));
                }
            }
            Op::Delete { node } => {
                let id = self.resolve(node)?;
                let node = self.copy(id)?;
                let parent = node.parent.ok_or(ErrorCode::Tree)?;
                if !node.children.is_empty() {
                    return Err(ErrorCode::Tree);
                }
                self.unlink(parent, id)?;
                self.bytes -= node.bytes();
                self.live -= 1;
                self.overlay.insert(id.slot, None);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_id_parts_require_live_local_open_session() {
        let mut session = Session::new(Limits::default()).unwrap();
        let other = Session::new(Limits::default()).unwrap();
        let root = session.stats().root;
        let (owner, slot, generation) = root.parts();
        assert_eq!(
            session.node_id_from_parts(owner, slot, generation),
            Ok(root)
        );
        for parts in [
            other.stats().root.parts(),
            (owner, usize::MAX, generation),
            (owner, slot, generation + 1),
        ] {
            assert_eq!(
                session
                    .node_id_from_parts(parts.0, parts.1, parts.2)
                    .unwrap_err()
                    .code,
                ErrorCode::Id
            );
        }
        let id = session
            .apply_batch(
                0,
                &[Op::Create {
                    temp: 0,
                    parent: NodeRef::Id(root),
                    kind: NodeSpec::Box,
                }],
            )
            .unwrap()
            .created[0]
            .1;
        let (owner, slot, generation) = id.parts();
        assert_eq!(session.node_id_from_parts(owner, slot, generation), Ok(id));
        session
            .apply_batch(
                1,
                &[Op::Delete {
                    node: NodeRef::Id(id),
                }],
            )
            .unwrap();
        assert_eq!(
            session
                .node_id_from_parts(owner, slot, generation)
                .unwrap_err()
                .code,
            ErrorCode::Id
        );
        let reused = session
            .apply_batch(
                2,
                &[Op::Create {
                    temp: 0,
                    parent: NodeRef::Id(root),
                    kind: NodeSpec::Box,
                }],
            )
            .unwrap()
            .created[0]
            .1;
        assert_eq!(reused.parts(), (owner, slot, generation + 1));
        assert_eq!(
            session
                .node_id_from_parts(owner, slot, generation)
                .unwrap_err()
                .code,
            ErrorCode::Id
        );
        session.close();
        let (owner, slot, generation) = root.parts();
        assert_eq!(
            session
                .node_id_from_parts(owner, slot, generation)
                .unwrap_err()
                .code,
            ErrorCode::Closed
        );
    }

    #[test]
    fn exhaustion_never_wraps() {
        let counter = AtomicU64::new(u64::MAX - 1);
        assert_eq!(next_session(&counter), Ok(u64::MAX - 1));
        assert_eq!(next_session(&counter), Err(ErrorCode::Exhausted));
        let mut s = Session::new(Limits::default()).unwrap();
        let root = NodeRef::Id(s.stats.root);
        let create = Op::Create {
            temp: 0,
            parent: root,
            kind: NodeSpec::Box,
        };
        s.stats.revision = u32::MAX;
        assert!(s.apply_batch(u32::MAX, &[]).is_ok());
        let before = s.stats();
        assert_eq!(
            s.apply_batch(u32::MAX, &[create]).unwrap_err().code,
            ErrorCode::Exhausted
        );
        assert_eq!(s.stats(), before);
        s.stats.revision = 0;
        let id = s.apply_batch(0, &[create]).unwrap().created[0].1;
        s.arena[id.slot].generation = u32::MAX - 1;
        let penultimate = NodeId {
            generation: u32::MAX - 1,
            ..id
        };
        // 同步父引用，仅用于构造 generation 耗尽前的内部合法状态。
        s.arena[0].node.as_mut().unwrap().children[0] = penultimate;
        s.apply_batch(
            1,
            &[Op::Delete {
                node: NodeRef::Id(penultimate),
            }],
        )
        .unwrap();
        assert_eq!(s.stats().retired_slots, 0);
        assert_eq!(s.free, vec![id.slot]);
        let last = s.apply_batch(2, &[create]).unwrap().created[0].1;
        assert_eq!(last.slot, id.slot);
        assert_eq!(last.generation, u32::MAX);
        assert_eq!(s.inspect(&[penultimate]).unwrap_err().code, ErrorCode::Id);
        let all = [s.stats.root, last];
        let before = s.inspect(&all).unwrap();
        let stats = s.stats();
        let error = s
            .apply_batch(
                3,
                &[
                    Op::Delete {
                        node: NodeRef::Id(last),
                    },
                    create,
                    Op::Delete { node: root },
                ],
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Tree);
        assert_eq!(error.op_index, Some(2));
        assert_eq!(s.stats(), stats);
        assert_eq!(s.inspect(&all).unwrap(), before);
        assert_eq!(s.arena[last.slot].generation, u32::MAX);
        assert!(s.free.is_empty());
        s.apply_batch(
            3,
            &[Op::Delete {
                node: NodeRef::Id(last),
            }],
        )
        .unwrap();
        assert_eq!(s.stats().retired_slots, 1);
        assert_eq!(s.stats().free_slots, 0);
        let next = s.apply_batch(4, &[create]).unwrap().created[0].1;
        assert_eq!(next.slot, last.slot + 1);
        assert_eq!(next.generation, 0);
        assert_eq!(s.inspect(&[last]).unwrap_err().code, ErrorCode::Id);
    }

    #[test]
    fn traversal_budget_counts_siblings_and_ancestors() {
        let mut s = Session::new(Limits::default()).unwrap();
        let root = s.stats.root;
        let mut parent = root;
        for _ in 0..12 {
            parent = s
                .apply_batch(
                    s.stats.revision,
                    &[Op::Create {
                        temp: 0,
                        parent: NodeRef::Id(parent),
                        kind: NodeSpec::Box,
                    }],
                )
                .unwrap()
                .created[0]
                .1;
        }
        let op = Op::Reparent {
            node: NodeRef::Id(parent),
            parent: NodeRef::Id(parent),
        };
        assert_eq!(s.apply_batch(12, &[op]).unwrap_err().code, ErrorCode::Tree);
        let root_child = s.inspect(&[root]).unwrap()[0].children[0];
        let cycle = Op::Reparent {
            node: NodeRef::Id(root_child),
            parent: NodeRef::Id(parent),
        };
        s.limits.visits = 10;
        let before = s.stats();
        assert_eq!(
            s.apply_batch(12, &[cycle]).unwrap_err().code,
            ErrorCode::Limit
        );
        assert_eq!(s.stats(), before);
        s.limits.visits = 65536;
        assert_eq!(
            s.apply_batch(12, &[cycle]).unwrap_err().code,
            ErrorCode::Tree
        );
        // 根兄弟克隆随宽度收费；降低限额不会隐藏在 Vec::clone 中绕过预算。
        for _ in 0..20 {
            s.apply_batch(
                s.stats.revision,
                &[Op::Create {
                    temp: 0,
                    parent: NodeRef::Id(root),
                    kind: NodeSpec::Box,
                }],
            )
            .unwrap();
        }
        let wide = s.inspect(&[root]).unwrap().remove(0);
        let before = s.stats();
        // 重复请求不去重：每次包含两次节点访问及两倍 children 长度的估算。
        let cost = 2 + 2 * wide.children.len();
        s.limits.visits = cost * 2;
        assert_eq!(s.inspect(&[root, root]).unwrap(), vec![wide.clone(), wide]);
        s.limits.visits = cost * 2 - 1;
        let error = s.inspect(&[root, root]).unwrap_err();
        assert_eq!(error.code, ErrorCode::Limit);
        assert_eq!(error.op_index, None);
        s.limits.visits = 0;
        assert!(s.inspect(&[]).unwrap().is_empty());
        assert_eq!(s.inspect(&[root]).unwrap_err().code, ErrorCode::Limit);
        assert_eq!(s.stats(), before);
        s.limits.visits = 20;
        let before = s.stats();
        let error = s.apply_batch(
            before.revision,
            &[Op::Create {
                temp: 0,
                parent: NodeRef::Id(root),
                kind: NodeSpec::Box,
            }],
        );
        assert_eq!(error.unwrap_err().code, ErrorCode::Limit);
        assert_eq!(s.stats(), before);
    }
}

import sqlite3
import unittest
from pathlib import Path


class MigrationAndTransactionTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:", isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        migrations = Path(__file__).resolve().parents[1] / "migrations"
        for migration in sorted(migrations.glob("*.sql")):
            self.db.executescript(migration.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def seed_task(self, task_id="task-1", status="in_progress"):
        self.db.execute(
            "INSERT INTO tasks (id, title, status) VALUES (?, 'Test task', ?)",
            (task_id, status),
        )

    def test_all_migrations_apply_to_a_clean_database(self):
        names = {
            row["name"]
            for row in self.db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        self.assertTrue(
            {"workers", "tasks", "task_events", "approval_requests", "task_submissions"}
            .issubset(names)
        )
        columns = {
            row["name"]
            for row in self.db.execute("PRAGMA table_info(approval_requests)")
        }
        self.assertIn("consumed_at", columns)

    def test_execution_approval_can_only_be_consumed_once(self):
        self.seed_task(status="assigned")
        self.db.execute(
            "INSERT INTO approval_requests (id, task_id, action_type, summary, status) "
            "VALUES ('approval-1', 'task-1', 'task_execution', 'Run task', 'approved')"
        )

        for _ in range(2):
            self.db.execute("BEGIN")
            self.db.execute(
                "UPDATE approval_requests SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
                "WHERE id = 'approval-1' AND status = 'approved' AND consumed_at IS NULL"
            )
            self.db.execute(
                "INSERT INTO task_events (task_id, actor_type, actor_id, event_type, payload_json) "
                "SELECT 'task-1', 'system', 'approval_gate', 'execution_approval_consumed', '{}' "
                "WHERE changes() = 1"
            )
            self.db.execute("COMMIT")

        events = self.db.execute(
            "SELECT COUNT(*) AS n FROM task_events WHERE event_type = 'execution_approval_consumed'"
        ).fetchone()["n"]
        self.assertEqual(events, 1)

    def test_submission_review_commits_submission_task_and_audit_together(self):
        self.seed_task()
        self.db.execute(
            "INSERT INTO workers (id, name, role) VALUES ('worker-1', 'Worker', 'research')"
        )
        self.db.execute(
            "INSERT INTO task_submissions (id, task_id, worker_id, summary, content) "
            "VALUES ('submission-1', 'task-1', 'worker-1', 'Summary', 'Content')"
        )

        self.db.execute("BEGIN")
        self.db.execute(
            "UPDATE task_submissions SET status = 'accepted', reviewed_at = 'now' "
            "WHERE id = 'submission-1' AND status = 'submitted' "
            "AND EXISTS (SELECT 1 FROM tasks WHERE id = 'task-1' AND status = 'in_progress')"
        )
        self.db.execute(
            "UPDATE tasks SET status = 'completed', completed_at = 'now' "
            "WHERE id = 'task-1' AND status = 'in_progress' AND changes() = 1"
        )
        self.db.execute(
            "INSERT INTO task_events (task_id, actor_type, actor_id, event_type, payload_json) "
            "SELECT 'task-1', 'manager', 'manager', 'submission_reviewed', '{}' "
            "WHERE changes() = 1"
        )
        self.db.execute("COMMIT")

        self.assertEqual(
            self.db.execute("SELECT status FROM task_submissions WHERE id='submission-1'").fetchone()["status"],
            "accepted",
        )
        self.assertEqual(
            self.db.execute("SELECT status FROM tasks WHERE id='task-1'").fetchone()["status"],
            "completed",
        )
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) AS n FROM task_events WHERE event_type='submission_reviewed'").fetchone()["n"],
            1,
        )

    def test_audit_failure_rolls_back_the_entire_submission_review(self):
        self.seed_task()
        self.db.execute(
            "INSERT INTO workers (id, name, role) VALUES ('worker-1', 'Worker', 'research')"
        )
        self.db.execute(
            "INSERT INTO task_submissions (id, task_id, worker_id, summary, content) "
            "VALUES ('submission-1', 'task-1', 'worker-1', 'Summary', 'Content')"
        )
        self.db.executescript(
            "CREATE TRIGGER fail_review_audit BEFORE INSERT ON task_events "
            "WHEN NEW.event_type = 'submission_reviewed' "
            "BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END;"
        )

        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("BEGIN")
            self.db.execute(
                "UPDATE task_submissions SET status = 'accepted', reviewed_at = 'now' "
                "WHERE id = 'submission-1' AND status = 'submitted' "
                "AND EXISTS (SELECT 1 FROM tasks WHERE id = 'task-1' AND status = 'in_progress')"
            )
            self.db.execute(
                "UPDATE tasks SET status = 'completed', completed_at = 'now' "
                "WHERE id = 'task-1' AND status = 'in_progress' AND changes() = 1"
            )
            self.db.execute(
                "INSERT INTO task_events (task_id, actor_type, actor_id, event_type, payload_json) "
                "SELECT 'task-1', 'manager', 'manager', 'submission_reviewed', '{}' "
                "WHERE changes() = 1"
            )
        self.db.execute("ROLLBACK")

        self.assertEqual(
            self.db.execute("SELECT status FROM task_submissions WHERE id='submission-1'").fetchone()["status"],
            "submitted",
        )
        self.assertEqual(
            self.db.execute("SELECT status FROM tasks WHERE id='task-1'").fetchone()["status"],
            "in_progress",
        )


if __name__ == "__main__":
    unittest.main()

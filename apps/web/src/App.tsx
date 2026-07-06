import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  api,
  ApiError,
  type ClassroomDetail,
  type ClassroomSummary,
  type Me,
  type RosterEntry,
} from "./api";

function useMe() {
  return useQuery<Me | null>({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      try {
        return await api<Me>("/app/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

function Landing() {
  return (
    <div className="landing">
      <h1>HEIG GitHub Classroom</h1>
      <p>Portail des travaux pratiques sur GitHub.</p>
      <a className="btn" href="/app/auth/login">
        Se connecter (Switch edu-ID)
      </a>
    </div>
  );
}

function RosterTable({ roster }: { roster: RosterEntry[] }) {
  if (roster.length === 0) return <p className="muted">Roster vide — importe un CSV.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Nom</th>
          <th>Prénom</th>
          <th>E-mail</th>
          <th>Statut</th>
          <th>GitHub</th>
          <th>Dernière connexion</th>
        </tr>
      </thead>
      <tbody>
        {roster.map((r) => (
          <tr key={r.id}>
            <td>{r.nom}</td>
            <td>{r.prenom}</td>
            <td>{r.email}</td>
            <td>
              <span className={`badge ${r.status}`}>
                {r.status === "claimed" ? "réclamé" : "en attente"}
              </span>
              {r.conflictFlag ? " ⚠︎ conflit" : null}
            </td>
            <td>{r.githubLogin ?? "—"}</td>
            <td>{r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleString("fr-CH") : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ClassroomView({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery<ClassroomDetail>({
    queryKey: ["classroom", id],
    queryFn: () => api(`/app/api/classrooms/${id}`),
  });
  const [csv, setCsv] = useState("nom,prenom,email\n");
  const importRoster = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${id}/roster`, { method: "POST", csv }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classroom", id] }),
  });

  if (detail.isLoading) return <p>Chargement…</p>;
  if (!detail.data) return <p className="error">Classroom introuvable.</p>;
  const room = detail.data;
  return (
    <div>
      <button className="ghost" onClick={onBack}>
        ← Classrooms
      </button>
      <div className="card">
        <h2>{room.name}</h2>
        <p className="muted">
          Organisation : <strong>{room.org?.login}</strong>
          {room.org?.installationId
            ? " (GitHub App installée)"
            : " — GitHub App non installée (jalon M2)"}
        </p>
        <h3>Roster</h3>
        <RosterTable roster={room.roster} />
        <h3>Importer le roster (CSV)</h3>
        <textarea
          aria-label="CSV du roster"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <div>
          <button onClick={() => importRoster.mutate()} disabled={importRoster.isPending}>
            Importer
          </button>
        </div>
        {importRoster.isError ? (
          <p className="error">
            Import refusé :{" "}
            {JSON.stringify((importRoster.error as ApiError).body ?? "erreur")}
          </p>
        ) : null}
        {importRoster.isSuccess ? <p>Import effectué.</p> : null}
      </div>
    </div>
  );
}

function TeacherHome() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const rooms = useQuery<ClassroomSummary[]>({
    queryKey: ["classrooms"],
    queryFn: () => api("/app/api/classrooms"),
  });
  const create = useMutation({
    mutationFn: () =>
      api("/app/api/classrooms", {
        method: "POST",
        body: JSON.stringify({ name, orgLogin: org }),
      }),
    onSuccess: () => {
      setName("");
      setOrg("");
      void qc.invalidateQueries({ queryKey: ["classrooms"] });
    },
  });

  if (selected) return <ClassroomView id={selected} onBack={() => setSelected(null)} />;
  return (
    <div>
      <div className="card">
        <h2>Mes classrooms</h2>
        {rooms.data?.length ? (
          <table>
            <thead>
              <tr>
                <th>Nom</th>
                <th>Organisation</th>
                <th>Étudiants</th>
                <th>Réclamés</th>
              </tr>
            </thead>
            <tbody>
              {rooms.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href="#" onClick={(e) => (e.preventDefault(), setSelected(c.id))}>
                      {c.name}
                    </a>
                  </td>
                  <td>{c.orgLogin}</td>
                  <td>{c.students}</td>
                  <td>{c.claimed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Aucune classroom pour l'instant.</p>
        )}
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <input
            placeholder="Nom (ex. PRG1 2026)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            placeholder="Organisation GitHub"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            required
          />
          <button disabled={create.isPending}>Créer la classroom</button>
        </form>
        {create.isError ? <p className="error">Création refusée.</p> : null}
      </div>
    </div>
  );
}

function StudentHome({ me }: { me: Me }) {
  return (
    <div className="card">
      <h2>Mes assignments</h2>
      <p className="muted">
        Aucun assignment pour l'instant — ils apparaîtront ici dès que ton enseignant en
        publiera (jalon M2).
      </p>
      {me.githubLogin ? null : (
        <p>
          Pense à lier ton compte GitHub (bientôt disponible) pour pouvoir accepter les
          assignments.
        </p>
      )}
    </div>
  );
}

export default function App() {
  const me = useMe();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api("/app/auth/logout", { method: "POST" }),
    onSuccess: () => qc.setQueryData(["me"], null),
  });

  if (me.isLoading) return null;
  if (!me.data) return <Landing />;
  const u = me.data;
  return (
    <div>
      <header className="app">
        <h1>HEIG GitHub Classroom</h1>
        <span className="who">
          {u.givenName} {u.familyName} · {u.role === "teacher" ? "enseignant" : "étudiant"}
        </span>
        <button className="ghost" onClick={() => logout.mutate()}>
          Se déconnecter
        </button>
      </header>
      {u.role === "teacher" ? <TeacherHome /> : <StudentHome me={u} />}
    </div>
  );
}

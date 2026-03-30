#!/usr/bin/env ruby

require "date"
require "json"
require "net/http"
require "uri"
require "yaml"

ROOT = File.expand_path("..", __dir__)
PUBLICATION_GLOB = File.join(ROOT, "_data", "publications", "*.yml")
USER_AGENT = "hq-fang-publication-metrics-updater"
REQUEST_DELAY_SECONDS = 1

def load_publication(path)
  YAML.safe_load(File.read(path), permitted_classes: [Date], aliases: true) || {}
end

def fetch_json(url, headers: {}, max_attempts: 3)
  uri = URI(url)
  (1..max_attempts).each do |attempt|
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == "https"
    http.open_timeout = 10
    http.read_timeout = 20

    begin
      request = Net::HTTP::Get.new(uri)
      headers.each do |key, value|
        request[key] = value if value && !value.empty?
      end

      response = http.request(request)
      return JSON.parse(response.body) if response.is_a?(Net::HTTPSuccess)

      warn "Request failed for #{url}: HTTP #{response.code}"
      if response.code.to_i == 429 && attempt < max_attempts
        retry_after = response["retry-after"].to_i
        wait_seconds = [retry_after, attempt * 5].max
        sleep(wait_seconds)
        next
      end
    rescue StandardError => error
      warn "Request failed for #{url}: #{error.class}: #{error.message}"
    end

    sleep(attempt * 2) if attempt < max_attempts
  end

  nil
end

def fetch_citation_count(publication)
  citation = publication["citation"] || {}
  return nil unless citation["provider"] == "semanticscholar"
  return nil unless citation["id"]

  encoded_id = URI.encode_www_form_component(citation["id"])
  url = "https://api.semanticscholar.org/graph/v1/paper/#{encoded_id}?fields=citationCount"
  headers = { "User-Agent" => USER_AGENT }
  api_key = ENV["SEMANTIC_SCHOLAR_API_KEY"]
  headers["x-api-key"] = api_key if api_key && !api_key.empty?
  payload = fetch_json(url, headers: headers)

  payload && payload["citationCount"]
end

def fetch_github_stars(publication)
  repo = publication["github_repo"]
  return nil unless repo

  headers = {
    "Accept" => "application/vnd.github+json",
    "User-Agent" => USER_AGENT
  }
  token = ENV["GITHUB_TOKEN"] || ENV["GH_TOKEN"]
  headers["Authorization"] = "Bearer #{token}" if token && !token.empty?

  payload = fetch_json("https://api.github.com/repos/#{repo}", headers: headers)
  payload && payload["stargazers_count"]
end

def replace_integer_field(content, field_name, value)
  replaced = false
  pattern = /^(\s*#{Regexp.escape(field_name)}:\s*)\d+\s*$/

  updated_content = content.sub(pattern) do
    replaced = true
    "#{Regexp.last_match(1)}#{value}"
  end

  unless replaced
    warn "Could not find #{field_name} in file; leaving it unchanged."
    return [content, false]
  end

  [updated_content, updated_content != content]
end

changed_files = []

Dir.glob(PUBLICATION_GLOB).sort.each do |path|
  publication = load_publication(path)
  content = File.read(path)
  updated = false

  if (citation_count = fetch_citation_count(publication))
    content, field_updated = replace_integer_field(content, "citation_count", citation_count)
    updated ||= field_updated
  end

  sleep(REQUEST_DELAY_SECONDS)

  if (github_stars = fetch_github_stars(publication))
    content, field_updated = replace_integer_field(content, "github_stars", github_stars)
    updated ||= field_updated
  end

  sleep(REQUEST_DELAY_SECONDS)

  next unless updated

  File.write(path, content)
  changed_files << File.basename(path)
  puts "Updated #{File.basename(path)}"
end

if changed_files.empty?
  puts "No publication metric changes found."
else
  puts "Changed files: #{changed_files.join(', ')}"
end
